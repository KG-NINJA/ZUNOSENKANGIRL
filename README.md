# WebLLM Enemy Brain patch

This patch adds a browser-side tactical LLM layer to the existing 1v1 shooter.

- GitHub Pages compatible: no server required for WebLLM mode.
- The old localhost WebSocket path is kept only for local development.
- WebLLM runs every 5 seconds and returns a small JSON tactic.
- Frame-by-frame movement and collision remain deterministic JavaScript.

Usage:
1. Put index.html, main.js, and style.css in the GitHub Pages root.
2. Open the page in Chrome or Edge with WebGPU support.
3. Click `Load WebLLM`.
4. Start the game.

If the model id stops working, replace `WEBLLM_MODEL` in main.js with a currently supported WebLLM 1B-class instruct model.
