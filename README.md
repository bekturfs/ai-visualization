# ai-visualization

Interactive visualizations for understanding how AI works — from neural network basics to LLM internals and deep research agents.

## Why

Reading about AI is one thing; **seeing** it is another. The goal of this project is to learn everything related to AI by building visualizations of the core concepts — each one small, interactive, and focused on a single idea.

> 🚧 Early stage: this is a learning roadmap. Visualizations will be checked off as they are built.

## Roadmap

### 1. Neural Network Fundamentals
- [ ] Neuron & activation functions — what a single neuron computes
- [ ] Forward pass — how data flows through layers
- [ ] Gradient descent — loss landscape and how the network learns
- [ ] Backpropagation — how errors flow backwards

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

To be decided — likely a web stack (interactive visualizations in the browser). Will be documented here once the first visualization is built.

## Project Structure

One folder per visualization, each self-contained. Details will appear as the project grows.

## License

Not yet specified.
