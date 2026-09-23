"""Interrupting the assistant by speaking, without it interrupting itself.

While the assistant thinks or speaks, the microphone still hears the room: the assistant's own
voice from the speakers (no echo cancellation in every webview), coughs, doors, and sometimes
the user. Three gates decide, the last one has the final word:

1. sustained speech according to the VAD (not a click or a bang);
2. louder than the echo we expect. The daemon knows the audio it sent and where playback is,
   so it learns how strongly the speakers couple into the microphone;
3. actual words that are not the assistant's own (`judge`), checked with Whisper on a short
   snippet while playback is ducked.

Gates 1 and 2 only nominate a candidate cheaply; gate 3 is what makes it robust.
"""

from __future__ import annotations

import re
import time
from collections import deque
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Literal

from graite.voice.frames import FRAME_SECONDS

FRAME_MS = FRAME_SECONDS * 1000
HISTORY_FRAMES = 96  # ~3 s of microphone history for the echo model
MAX_LAG_FRAMES = 15  # speakers -> microphone delay searched up to ~480 ms
WINDOW = 10  # candidate: VOTES of the last WINDOW frames are the user speaking
VOTES = 6  # ~0.2 s: a crisp "stop" is not much longer
VAD_SPEECH = 0.6
VAD_QUIET = 0.35
MARGIN_DB = 5.0  # on top of a peak-held reference, which is already a generous bound
REJECT_BUMP_DB = 2.0
QUIET_REFERENCE = 0.03  # softer than this, the reference says little about the echo
WARMUP_FRAMES = 24  # echo-only frames needed before the echo estimate is trusted
PRE_ROLL_FRAMES = 16  # ~0.5 s kept from before the candidate
JUDGED_LEAD_FRAMES = 6  # Whisper hears ~0.2 s before the candidate, the rest is ducked
SNIPPET_SPEECH_FRAMES = 25  # ~0.8 s of speech after the candidate is enough for words
SNIPPET_MAX_FRAMES = 47  # never wait longer than ~1.5 s
COOLDOWN_SECONDS = 1.0
MIN_CONFIDENCE = -0.6  # Whisper's mean token log-probability; clear speech is around -0.1

# One word is enough when it is a command to stop; never when it is just listening noise.
STOP_WORDS = frozenset(
    "stop wait hold pause no nope halt cancel quiet enough "
    "wacht nee stil ho genoeg "
    "stopp warte nein genug ruhe "
    "arrête arrete attends non assez "
    "para espera basta alto "
    "fermati aspetta".split()
)
BACKCHANNELS = frozenset(
    "ok okay okee oke yeah yes yep yup ja jaja sure right mm mhm hmm hm uh huh uhhuh ah oh "
    "aha si sì oui genau klar goed mooi top nice cool thanks bedankt danke merci".split()
)
_NOISE = re.compile(r"[\[\(][^\]\)]*[\]\)]|♪")
# Whole words only: of "25th" nothing is kept, so numbers, which the assistant speaks as words
# and Whisper writes as digits, neither count for nor against an echo.
_WORD = re.compile(r"(?<![\w'])[^\W\d_]+(?:'[^\W\d_]+)?(?![\w'])", re.UNICODE)


def words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(_NOISE.sub(" ", text))]


@dataclass
class Verdict:
    interrupt: bool
    reason: Literal["words", "command", "nothing", "unclear", "echo", "backchannel"]


def _same(a: str, b: str) -> bool:
    """Whisper hears an echo imperfectly ("Peter" for "Pieter", "hold" for "holds")."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.8


def echo_share(heard: list[str], spoken: list[str]) -> float:
    """How much of what was heard is a stretch of what the assistant said, in the same order.
    Order matters: "I meant the budget, who reviews it" shares its words with "Anna reviews
    the budget" but is not an echo of it; loose word matching would let "the", "I" and "is"
    decide."""
    if not heard or not spoken:
        return 0.0
    width = len(heard) + 3
    best = 0
    for start in range(max(1, len(spoken) - width + 1)):
        window = spoken[start : start + width]
        # Longest common subsequence of `heard` and this window, with forgiving equality.
        row = [0] * (len(window) + 1)
        for word in heard:
            previous = 0
            for j, other in enumerate(window, 1):
                keep = row[j]
                row[j] = previous + 1 if _same(word, other) else max(row[j], row[j - 1])
                previous = keep
        best = max(best, row[-1])
    return best / len(heard)


def judge(heard_text: str, assistant_text: str, confidence: float | None = None) -> Verdict:
    """Is this snippet the user taking the floor? `assistant_text` is what was being played
    around that moment: a transcript that is a stretch of it is our own echo. `confidence` is
    Whisper's (`SpeechServer.transcribe`): a vacuum cleaner or a slammed door can make it
    imagine words, but not confidently."""
    heard = words(heard_text)
    if not heard:
        return Verdict(False, "nothing")
    if confidence is not None and confidence < MIN_CONFIDENCE:
        return Verdict(False, "unclear")
    spoken = words(assistant_text)
    commands = [w for w in heard if w in STOP_WORDS and w not in spoken]
    if commands:
        return Verdict(True, "command")
    # Most of it is what the assistant was saying: our own voice from the speakers. A user who
    # really repeats the assistant's words to cut in is asked to say it again, or "wait".
    if spoken and echo_share(heard, spoken) >= 0.6:
        return Verdict(False, "echo")
    content = [w for w in heard if w not in BACKCHANNELS]
    if len(content) >= 2 or (content and len(heard) >= 2):
        return Verdict(True, "words")
    return Verdict(False, "backchannel")


class ReferenceTrack:
    """The loudness envelope of what the assistant is playing, on the client's playback clock
    (milliseconds of this answer's audio that have been played, gaps not counted)."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._levels: list[float] = []
        self._rest = b""
        self._rate = 24000
        self._played_ms = 0.0
        self._reported_at: float | None = None  # microphone time of the last report

    def append(self, pcm: bytes, rate: int) -> None:
        import numpy as np

        self._rate = rate
        data = self._rest + pcm
        size = int(rate * FRAME_SECONDS) * 2
        cut = len(data) - len(data) % size
        self._rest = data[cut:]
        if not cut:
            return
        samples = np.frombuffer(data[:cut], dtype="<i2").astype(np.float32) / 32768.0
        frames = samples.reshape(-1, size // 2)
        self._levels.extend(np.sqrt((frames * frames).mean(axis=1)).tolist())

    def clock(self, played_ms: float, mic_ms: float) -> None:
        """The client says how much of the answer has been played. `mic_ms` is how much
        microphone audio had arrived when it said so: both travel the same ordered socket, so
        this pins playback to the microphone's timeline to the frame, whatever the network
        or the event loop did in between."""
        if played_ms > self.total_ms + 500:
            return  # a late report about the previous answer: more than was ever sent of this one
        self._played_ms = max(self._played_ms, played_ms)
        self._reported_at = mic_ms

    @property
    def total_ms(self) -> float:
        return len(self._levels) * FRAME_MS

    def position(self, mic_ms: float) -> float:
        """Where playback was when the microphone frame at `mic_ms` was captured: the last
        report, advanced by the microphone time since (for up to a second)."""
        if self._reported_at is None:
            return 0.0
        ahead = min(1000.0, max(0.0, mic_ms - self._reported_at))
        return min(self.total_ms, self._played_ms + ahead)

    def level(self, ms: float) -> float:
        index = int(ms // FRAME_MS)
        return self._levels[index] if 0 <= index < len(self._levels) and ms >= 0 else 0.0


class EchoModel:
    """How loudly the reference comes back into the microphone.

    The echo arrives some unknown tens to hundreds of milliseconds after playback and is
    smeared by the room, so the reference is compared as a peak-hold over that whole range
    (`held`): whatever the delay is, the echo is never louder than gain x held. That needs no
    delay estimate, which is the part that goes wrong. The gain is a high percentile of
    microphone/held over the last seconds; a user talking over the assistant for a moment
    cannot move it much, and a candidate that Whisper proved to be echo raises it at once
    (`underestimated`). Without echo (headphones, real echo cancellation) the microphone stays
    at the room's noise while the assistant speaks and the gain is next to nothing: the gate
    is simply open."""

    def __init__(self, track: ReferenceTrack) -> None:
        self.track = track
        self.ratios: deque[float] = deque(maxlen=HISTORY_FRAMES)
        self.raw: deque[float] = deque(maxlen=32)  # every recent frame, the loud ones too
        self.gain = 0.0
        self.noise = 0.003
        self.trained = 0
        self.floor_gain = 0.0  # raised by proven echo; fades again over a few fits
        self._since_fit = 0

    def held(self, position: float) -> float:
        """The loudest the reference has been over the range an echo of it can still arrive
        from (and a little ahead, for clock jitter)."""
        return max(
            self.track.level(position - back * FRAME_MS) for back in range(-3, MAX_LAG_FRAMES + 1)
        )

    def observe(self, mic: float, position: float, *, learn: bool, speech: bool = False) -> None:
        """`learn` is False for frames that stand out as somebody talking: they would teach
        the model that the echo is loud. If it really was echo, Whisper says so and
        `underestimated` corrects the gain from `raw`."""
        held = self.held(position)
        if held < QUIET_REFERENCE:
            if held < 1e-4 and not speech:  # the room's hum, not somebody talking in a pause
                self.noise = 0.95 * self.noise + 0.05 * max(mic, 1e-4)
            return
        # Without the room's noise, which would otherwise pass for echo where the assistant
        # speaks softly.
        ratio = max(0.0, mic - self.noise) / held
        self.raw.append(ratio)
        if not learn:
            return
        self.ratios.append(ratio)
        self.trained += 1
        self._since_fit += 1
        if self._since_fit >= 8 and len(self.ratios) >= WARMUP_FRAMES:
            self._since_fit = 0
            self._fit()

    def _fit(self) -> None:
        import numpy as np

        # A clean echo never exceeds gain x held, so the gain sits at the top of the ratios.
        self.floor_gain *= 0.93
        self.gain = max(self.floor_gain, float(np.percentile(np.asarray(self.ratios), 90)))

    @property
    def ready(self) -> bool:
        return self.trained >= WARMUP_FRAMES

    def underestimated(self) -> None:
        """A candidate turned out to be the assistant's own voice: the echo is louder than
        assumed. Cover what was just heard, and believe that for a while."""
        import numpy as np

        recent = list(self.raw)
        proven = float(np.percentile(recent, 90)) if len(recent) >= 4 else self.gain * 1.6
        if self.ready and self.gain > 0.02:
            proven = min(proven, self.gain * 3)  # a bang on top of the echo is not the echo
        self.gain = self.floor_gain = max(self.gain, proven, 0.02)

    def expected(self, position: float) -> float:
        return self.noise + self.gain * self.held(position)


class BargeInGuard:
    """Frames in while the assistant has the floor; nominates a candidate interruption and
    then collects the snippet Whisper will judge."""

    def __init__(self, track: ReferenceTrack) -> None:
        self.track = track
        self.echo = EchoModel(track)
        self._recent: deque[bytes] = deque(maxlen=PRE_ROLL_FRAMES + WINDOW)
        self._votes: deque[bool] = deque(maxlen=WINDOW)
        self.mic_ms = 0.0  # microphone audio seen so far: the clock everything is aligned on
        self.begin_answer()

    def begin_answer(self) -> None:
        """A new answer starts: forget the candidate state, keep what was learned about echo."""
        self.margin_db = MARGIN_DB
        self._rejects = 0
        self._cooldown_until = 0.0
        self._votes.clear()
        self._recent.clear()
        self.collecting = False
        self._frames: list[bytes] = []
        self._lead = 0
        self._speech_frames = 0
        self._quiet_frames = 0

    @staticmethod
    def _rms(frame: bytes) -> float:
        import numpy as np

        samples = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
        return float(np.sqrt((samples * samples).mean())) if len(samples) else 0.0

    def feed(self, frame: bytes, prob: float, now: float | None = None) -> bool:
        """True when this frame makes a candidate: the caller ducks playback and starts
        collecting. While collecting, frames are only gathered."""
        now = time.monotonic() if now is None else now
        self.mic_ms += FRAME_MS
        if self.collecting:
            self._frames.append(frame)
            if prob >= VAD_QUIET:
                self._speech_frames += 1
                self._quiet_frames = 0
            else:
                self._quiet_frames += 1
            return False
        position = self.track.position(self.mic_ms)
        playing = self.track.level(position) > 1e-4 or position < self.track.total_ms
        level = self._rms(frame)
        expected = self.echo.expected(position)
        over = level >= expected * 10 ** (self.margin_db / 20)
        vote = prob >= VAD_SPEECH and over and (self.echo.ready or not playing)
        self.echo.observe(
            level, position, learn=not (over and self.echo.ready), speech=prob >= VAD_QUIET
        )
        self._recent.append(frame)
        self._votes.append(vote)
        if now < self._cooldown_until or sum(self._votes) < VOTES:
            return False
        self.collecting = True
        self._frames = list(self._recent)
        self._lead = len(self._frames)
        self._speech_frames = 0
        self._quiet_frames = 0
        return True

    @property
    def ready(self) -> bool:
        """Enough of the snippet is in: the speaker paused, said enough, or time is up."""
        if not self.collecting:
            return False
        return (
            self._speech_frames >= SNIPPET_SPEECH_FRAMES
            or self._quiet_frames >= 6
            or len(self._frames) >= SNIPPET_MAX_FRAMES
        )

    def snippet(self) -> bytes:
        """What Whisper judges: from just before the candidate. Earlier audio is the
        assistant at full volume and would drown the first words of the user; after the
        candidate playback is ducked and the user dominates."""
        start = max(0, self._lead - VOTES - JUDGED_LEAD_FRAMES)
        return b"".join(self._frames[start:])

    def frames(self) -> list[bytes]:
        return list(self._frames)

    def reject(self, now: float | None = None, *, echo: bool = False) -> None:
        now = time.monotonic() if now is None else now
        self._rejects += 1
        if echo:
            self.echo.underestimated()
        if self._rejects >= 2:
            self.margin_db = min(MARGIN_DB + 6.0, self.margin_db + REJECT_BUMP_DB)
        self._cooldown_until = now + COOLDOWN_SECONDS
        self.collecting = False
        self._frames = []
        self._votes.clear()

    def accept(self) -> list[bytes]:
        frames = self.frames()
        self.collecting = False
        self._frames = []
        self._votes.clear()
        return frames
