// Runs on the audio thread: hands every render quantum of the microphone to the page.
class GraiteCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("graite-capture", GraiteCapture);
