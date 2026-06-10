# ai-visualization

Interactive visualizations for understanding how AI works — from neural network basics to LLM internals and deep research agents.

## Why

Reading about AI is one thing; **seeing** it is another. The goal of this project is to learn everything related to AI by building visualizations of the core concepts — each one small, interactive, and focused on a single idea.

Every topic is built as a **step-by-step story in plain language** (with real-life analogies, animations and 3D where it helps), followed by a free-play sandbox with hands-on challenges. All numbers on screen are computed live — nothing is pre-recorded.

## Roadmap

### 1. Neural Network Fundamentals
- [x] [Neuron & activation functions](src/pages/Neuron.tsx) — what a single neuron computes: guided story, live signals flowing along the wires, honest formulas, challenges
- [x] [Forward pass](src/pages/ForwardPass.tsx) — animated wave of computation rolling through a 2–3–2 network; click any neuron to see its personal formula
- [x] [Gradient descent](src/pages/GradientDescent.tsx) — a real **3D loss landscape** (Three.js): orbit the valley, drop the ball anywhere, play with the learning rate, watch divergence and local minima traps
- [x] [Backpropagation](src/pages/Backprop.tsx) — micrograd-style computational graph with an animated "blame flow" running backwards, training steps and a live loss curve

### 2. How LLMs Work
- [ ] Tokenization — how text becomes tokens (BPE in action)
- [ ] Embeddings — words as vectors, semantic similarity in space
- [ ] Attention mechanism — what "tokens looking at each other" means
- [ ] Transformer architecture — the full picture, layer by layer
- [ ] Next-token prediction — probability distribution over the vocabulary
- [ ] Sampling — temperature, top-p, top-k and how they change output
- [ ] Context window & KV cache — why context is limited and what makes inference fast

### 3. Training LLMs
- [ ] Pretraining — learning from raw text at scale
- [ ] Fine-tuning — adapting a base model to follow instructions
- [ ] RLHF — how human feedback shapes model behavior

### 4. Deep Search & Agents
- [ ] RAG (Retrieval-Augmented Generation) — chunking, vector search, augmented prompts
- [ ] Deep research pipeline — query decomposition → parallel search → source verification → synthesis
- [ ] Tool use — how an LLM calls external tools and reads results
- [ ] Agent loop — plan, act, observe, repeat
- [ ] Multi-agent systems — orchestrating several agents on one task

### 5. Beyond Text
- [ ] Diffusion models — how images emerge from noise
- [ ] Multimodality — how models combine text, images, and audio

## Tech Stack

- **React 19 + TypeScript + Vite** — app shell and interactivity
- **Three.js / react-three-fiber + drei** — 3D scenes (loss landscape)
- **Motion (framer-motion)** — UI and SVG animations
- **Tailwind CSS 4** — styling
- Custom rAF-driven SVG particles for signal/gradient flows

The UI is in Russian with key terms duplicated in English, since the visualizations are designed as companions to English-language videos (3Blue1Brown's neural networks series and Andrej Karpathy's "Neural Networks: Zero to Hero").

## Getting Started

```bash
npm install
npm run dev      # dev server
npm run build    # production build (output in dist/)
npm run preview  # serve the production build locally
```

## Project Structure

```
src/
  pages/                — one page per visualization + home
    Neuron.tsx          — neuron & activation functions
    ForwardPass.tsx     — forward pass through a 2–3–2 network
    GradientDescent.tsx — 3D gradient descent on a loss landscape
    Backprop.tsx        — backpropagation on a computational graph
  components/
    StoryMode.tsx       — the step-by-step guided story engine
    FlowDots.tsx        — animated signal particles for SVG edges
    ui.tsx              — shared cards, sliders, buttons, animated numbers
  lib/                  — formatting and math helpers
scripts/
  shoot.mjs             — Playwright screenshot sweep used for visual checks
```

Each page follows the same pattern: a guided story (steps highlight parts of the scene and trigger animations) → a sandbox with live computation → hands-on challenges that check themselves.

## License

Not yet specified.
