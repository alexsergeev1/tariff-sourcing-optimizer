import { runStudy } from "./engine.mjs?v=2";

self.addEventListener("message", ({ data }) => {
  try {
    self.postMessage({ study: runStudy(data) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
});
