"""Realtime voice: microphone frames in, the assistant's spoken answer out.

frames -> Silero VAD -> Smart Turn (is the user done?) -> whisper.cpp -> the ordinary chat
turn -> sentence chunks -> a TTS engine. The two small ONNX models run on the CPU through
onnxruntime; speech recognition and synthesis stay with native GGML engines.
numpy and onnxruntime are imported lazily so the daemon starts without touching them.
"""
