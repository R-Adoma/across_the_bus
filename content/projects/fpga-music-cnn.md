+++
title = "Music Classification CNN on FPGA"
date = 2026-04-12T09:00:00+01:00
description = "Implementing a music genre classification convolutional neural network on an FPGA"
cover = "/img/projects/fpga-music-cnn/music_cnn_cover.jpg"
coverAlt = "Microphone Placeholder"
displayWords = 2063
tags = ["rtl", "floating-point", "notes"]
math = true
toc = true
repoUrl = "https://github.com/R-Adoma/fpga-music-genre-cnn"
repoLabel = "GitHub repository"
+++

## Motivation

Around last summer, after concluding a long group engineering project involving ray tracing and Pokemon (tale for another time), and fresh off the highs of sleepless nights debugging, I was looking to develop a large end-to-end system on an FPGA platform. Really, it was an exercise in tackling a project of that scale by myself and experiencing the nuances and pitfalls of doing so. I had not quite settled on the idea of an embedded accelerator until I looked up Headlock - Imogen Heap (banger) on Shazam, and now here we are.

## Specification + Research

Following on from the raw idea, I did some research to look at similar projects that had been done before and whether there were any models that were in the realm of what I was looking for. Luckily, the answer to both of those questions was yes. I found an RTL implementation of MNIST on Udemy that was relatively easy to follow, and the GTZAN dataset for music classification, along with many open-source models for it on Kaggle. The model I found aimed to take an input clip and classify it into one of `10` genres, so the final CNN is really a `10`-way music genre classifier.

The next step was then synthesising project requirements and goals that I would have to meet in order to realise my desired finished product.

- Design fits on target platform: PYNQ-Z2
- RTL CNN implementation works with high accuracy (> 50%)

I was not the most exhaustive with my constraints, but even those two alone had profound implications for how I went about the design in this project.

## What is a Convolutional Neural Network?

Very briefly, a convolutional neural network is a model that looks for local patterns in some structured input using lots of small sliding filters. Each filter moves across the input, responds strongly to certain shapes or features, and produces a new feature map showing where that pattern was found. Stacking several of these layers lets the network go from simple local features to more useful higher-level ones.

In this project the input is not a normal image but a mel spectrogram, which can still be treated a lot like one. Instead of looking for edges or textures in a photograph, the filters are looking for patterns in time-frequency space such as harmonics, transients and repeated structures. After a few convolution and pooling stages, the network ends up with a much smaller representation that still keeps the information most useful for deciding the music genre.

## Preprocessing and Input Representation

Before getting to the CNN itself, I first needed to turn the raw audio into something the model could work with sensibly. Rather than feeding waveform samples directly into the network, I converted each clip into a mel spectrogram. This gives a 2D time-frequency representation where brighter regions correspond to stronger energy at particular frequencies over time.

The reason for using a mel spectrogram specifically is that it compresses the frequency axis in a way that is closer to human hearing. That makes it a pretty natural fit for music classification, because what matters is usually not the exact raw waveform value at one instant but the broader spectral patterns, harmonics and transients over time. It also has the nice side effect that the input can be treated a lot like a small image, which makes a CNN a sensible model choice.

In practical terms this stage let me reduce each audio clip down to a fixed `128 x 128` single-channel input. That was much easier to handle than raw audio for both training and hardware deployment. It also meant I could keep the audio preprocessing off-chip and focus the RTL side of the project on the classifier itself.

<figure>
  <img src="../../img/projects/fpga-music-cnn/mel_spectrogram.png" alt="Example mel spectrogram used as CNN input">
  <figcaption>Example mel spectrogram used as input to the classifier</figcaption>
</figure>

## Model Design

So, to implement a music classification CNN on an FPGA, you need a music classification CNN. This is where I needed to be conscious of the target platform and its limitations. The PYNQ-Z2 board has the following resources:
- Approx 13.3 K LUTs
- 220 DSP slices
- 630 KB of block RAM

Most of the models freely available had parameter counts on the order of tens and hundreds of thousands, which is more than fine for any modern CPU to run, but too much for our resource-constrained PYNQ-Z2 board. This led me to do a bunch of iteration on different models until I settled on the following model with about six thousand parameters:

<figure>
  <img src="../../img/projects/fpga-music-cnn/genrecnn_hw_architecture_site.svg" alt="CNN Model Architecture">
  <figcaption>A figure depicting the CNN model architecture</figcaption>
</figure>

I used only 3 convolutional layers and global average pooling, as opposed to a fully connected layer, to try and keep the parameter count down so that the model would fit on the board.

## RTL Design, Testbench, REPEAT

Now that I had settled on the model, I began working on the meat and potatoes of this project: the RTL design.

I decided to split the project into the following modules.

<figure>
  <img src="../../img/projects/fpga-music-cnn/arch_fabric.png" alt="RTL Modules">
  <figcaption>RTL Module Dataflow</figcaption>
</figure>

I typically went through the loop of designing a module, verifying it with a testbench, solving the inevitable errors, and proceeding. Then, for most of the modules after the first, I did small integration testbenches, for example, one that tests a convolution buffer connected to a convolution layer. I will now give a brief summary of most of the modules and anything interesting that came up while designing and verifying them.

### Convolution Buffers

These modules are responsible for moving the convolution window across the incoming feature map. The main implementation detail here was ensuring that the wraparound logic was solid and that the signals sent downstream were asserted at the proper time.

It is also in these modules where you can see one of the key precision compromises I made to keep within the resource budget, using 7 fractional bits.

### Convolution Calculation

These modules are where the actual MAC operation happens. Once a valid `3x3` window is presented from the buffer, the corresponding kernel values are multiplied and accumulated, a bias is added, and the result is shifted back down into the range expected by the rest of the pipeline.

This is also where the exported weights really started to matter. Initially I wanted the fixed-point side to be much cleaner and more uniform, basically keeping everything in the same rough `Q1.7` style. In practice that did not hold up very well once the batch normalisation terms were folded into the weights before export. `conv1` especially wanted more headroom, so I ended up exporting `conv1` weights and biases at `16-bit`, while the later convolution weights could stay at `8-bit` and their biases at `16-bit`. It is a bit of a mishmash, but it was a practical compromise rather than a neat textbook design.

### Convolution Pool

These modules take the convolution outputs and perform max pooling and ReLU activation before handing data on to the next stage. The main reason for doing this was simply to keep the later layers manageable. Reducing the spatial size early means less buffering, less movement of data, and less arithmetic overall, which matters a lot on a small board like the PYNQ-Z2.

As with the buffers, the annoying part was not the operation itself so much as making sure everything happened at the correct time. The pooled values need to line up with the expected stride-two pattern and then be presented in a form the next buffer can consume cleanly. A lot of the checking here was really about sequencing rather than just whether the max operation itself was correct.

### Global Average Pool and Fully Connected Layers

I kept the back end of the network deliberately small. Rather than flattening a large final feature map into a huge fully connected layer, I used global average pooling to collapse each final channel down to a single value and then fed that into a `64 -> 10` classifier. That kept the memory footprint and parameter count low.

This stage was also one of the places where I leaned into approximation over elegance. The GAP block uses a simple fixed-point approximation for the divide instead of an expensive exact operation, which was good enough for the task and much more suitable for the hardware.

## Problems

One major problem I had was that, when I got to the end of the project for the first time and went to test on real data, I had abysmal accuracy. For a while I thought I was just dealing with local arithmetic bugs or a weak model. The reality was a bit broader: the software-side training assumptions and the RTL-side arithmetic were not aligned closely enough.

The hardware path was not a neat, uniform "int8 everywhere" pipeline. It was a mixed-width fixed-point design built around `FRAC_BITS = 7`, with wider storage for `conv1`, 8-bit later weights, 12-bit convolution outputs, clamped 8-bit inter-layer buffers, an extra shift in `conv1`, and an approximate divide in GAP. Saturation was definitely part of the picture, especially around the buffered activations between layers, but it was really a symptom of a bigger problem. The entire deployed numerical format was different enough from the training-time assumptions that activations which looked healthy in floating-point software could collapse once they were rounded, shifted, and clamped in hardware.

## Initial Tests

This is where the project got a lot more real. The software side looked fairly encouraging, but once I started checking the design properly in Verilator the numbers were a lot worse. Earlier versions were getting to around `~81%` in software training, but only around `~45%` in hardware simulation.

At that point it was pretty clear that this was not just a small RTL bug or a weak model. The bigger issue was that the training assumptions and the deployed arithmetic were far enough apart that the model which looked good in PyTorch was not really the same model once exported into the fixed-point pipeline.

<figure>
  <img src="../../img/projects/fpga-music-cnn/conf_matrix.png" alt="Confusion matrix for the RTL implementation">
  <figcaption>Confusion matrix for the RTL implementation</figcaption>
</figure>

## Quantisation Aware Training

This was what eventually got things back on track. The idea with QAT is that instead of training a floating-point/full-precision model first and only worrying about the damage afterwards, you let the model experience that damage during training. So rounding, clamping and reduced precision are all reflected in the forward pass while training still remains possible.

The main thing here was that generic int8 QAT was not really enough for this project. I needed the training flow to reflect the actual RTL, not just some standard quantised backend. That meant matching the `uint8` input quantisation, the mixed `16-bit` and `8-bit` weights, the `12-bit` intermediate outputs, the clamping between stages, the extra `conv1` shift and even the same approximation used in the GAP block.

Once I changed the training side to follow the hardware much more closely, the behaviour started to make far more sense. The architecture itself did not change. What changed was that the model was finally being trained for the thing it was actually going to run on.

<figure>
  <img src="../../img/projects/fpga-music-cnn/qat_mat.png" alt="Confusion matrix after hardware-aware quantisation-aware training">
  <figcaption>Confusion matrix after hardware-aware quantisation-aware training for the RTL implementation</figcaption>
</figure>

## Testing Again

This was the point where the project started to feel like it was coming together properly. After retraining with the hardware-aware flow, the gap between software and hardware shrank a lot. The final software QAT test accuracy was around `70.21%`, and Verilator reached `70.50%` on `1000` held-out test split samples.

That is probably the result I care about most in the whole project. Not because `70%` is some amazing classifier in isolation, but because the hardware result finally became believable and now met the specification point I had set myself at the beginning of being sufficiently accurate.

## Outro

This project ended up being much more about getting hardware and machine learning to agree with each other than about inventing some especially clever CNN. The final network is small, the arithmetic is constrained and parts of the pipeline are definitely a bit odd, but that is also what made it a worthwhile project.

I think one of the main takeaways I got from tackling this project is that, in design, especially when things go wrong, you need to check your assumptions and, even more importantly, be ready to challenge them if nothing else budges.

## Future Work

I'm going to put a pin in this for now, but there is definitely room for further extension and polishing:

- Add the audio preprocessing directly into the overall flow rather than relying on precomputed spectrograms
- Take the design fully through synthesis, implementation and place-and-route for the target board
- Build a small front end around the simulation flow so the project is easier to try without digging through scripts












