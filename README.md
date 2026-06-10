# ai-visualization

Interactive visualizations for understanding how AI works — from neural network basics to LLM internals and deep research agents.

## Why

Reading about AI is one thing; **seeing** it is another. The goal of this project is to learn everything related to AI by building visualizations of the core concepts — each one small, interactive, and focused on a single idea.

> 🚧 Early stage: this is a learning roadmap. Visualizations will be checked off as they are built.

## Roadmap

### 1. Neural Network Fundamentals
- [x] [Neuron & activation functions](visualizations/01-neuron/index.html) — what a single neuron computes
- [x] [Forward pass](visualizations/02-forward-pass/index.html) — how data flows through layers
- [x] [Gradient descent](visualizations/03-gradient-descent/index.html) — loss landscape and how the network learns
- [x] [Backpropagation](visualizations/04-backpropagation/index.html) — how errors flow backwards

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

Plain HTML + CSS + vanilla JavaScript — no frameworks, no build step, zero external dependencies. Every visualization is a single self-contained `index.html` (styles and scripts inlined) that works straight from `file://`.

To use it: clone the repo and open `index.html` in a browser. That's it.

The UI is in Russian with key terms duplicated in English, since the visualizations are designed as companions to English-language videos (3Blue1Brown's neural networks series and Andrej Karpathy's "Neural Networks: Zero to Hero").

## Project Structure

```
index.html                        — home page: links to all visualizations
visualizations/
  01-neuron/index.html            — neuron & activation functions
  02-forward-pass/index.html      — forward pass through a 2–3–2 network
  03-gradient-descent/index.html  — gradient descent on a loss landscape
  04-backpropagation/index.html   — backpropagation on a micrograd-style computational graph
```

One folder per visualization, each fully self-contained: markup, styles, and all the math live in one file you can read top to bottom.

## License

Not yet specified.
