+++
title = "Floating point from scratch: Hard mode"
date = 2026-04-03T09:00:00+01:00
description = "Sketching a tiny floating-point pipeline from first principles and learning where the sharp edges really are."
cover = "/img/posts/floating-point.svg"
coverAlt = "Abstract floating point placeholder illustration"
displayWords = 9355
tags = ["rtl", "floating-point", "notes"]
math = true
toc = true
+++

I wanted a floating-point block that felt understandable all the way down, so instead of reaching for an IP block, I started sketching the data path one awkward step at a time.

<!--more-->

The first surprise was not arithmetic. It was bookkeeping. Sign handling, exponent biasing, normalization, denormal edge cases, and rounding rules each feel manageable on their own, but together they turn into a careful choreography. This page is still dummy content, but it now acts as a realistic stand-in for the kind of longer engineering report the site will eventually host.

## How the format works

For IEEE-754 single precision, the value can be described as:

\[
(-1)^s \times 2^{E - 127} \times \left(1 + \frac{T}{2^{23}}\right)
\]

That compact equation hides a lot of sharp edges. The headline idea is simple enough:

- `s` stores the sign bit
- `E` stores the biased exponent
- `T` stores the trailing fraction field
- the hidden leading `1` only exists for normalized values
- everything awkward happens at the boundaries

Inline math works too, so I can talk about a normalized input such as \(1.75 = 1.11_2 \times 2^0\) without leaving the paragraph.

### Field layout

The first thing I like to do is translate the bit layout into a small table. It is boring, but it keeps later diagrams honest.

| Field | Width | Notes |
| --- | ---: | --- |
| Sign | 1 bit | `0` for positive, `1` for negative |
| Exponent | 8 bits | Stored with a bias of `127` |
| Fraction | 23 bits | Trailing bits of the significand |
| Internal guard bits | 3-5 bits | Helpful for alignment and rounding |

<figure>
  <img src="/img/posts/floating-point.svg" alt="Placeholder floating-point datapath sketch">
  <figcaption>A dummy front-page figure for the report. Later this could become a real datapath diagram or a screenshot from simulation.</figcaption>
</figure>

### What you never wanted to track

The arithmetic itself is not the exhausting part. The exhausting part is all the state you have to carry just to stay correct:

- whether either operand is zero
- whether either operand is denormal
- whether a cancellation event forces re-normalization
- which sticky bits were shifted out during alignment
- whether the current stage still has enough metadata to round correctly

> **Significand note.** In casual discussion people often say *mantissa*, but for binary floating-point *significand* is the cleaner term. For a lab note like this, I will happily use both if it keeps the prose readable.

## A tiny internal representation

My first simplifying move is usually to unpack the incoming word into a friendlier bundle. Instead of passing a raw `32'b...` value everywhere, I prefer something conceptually closer to this:

```verilog
typedef struct packed {
  logic        sign;
  logic [8:0]  exp_unbiased;
  logic [26:0] sig_ext;
  logic        is_zero;
  logic        is_inf;
  logic        is_nan;
} fp_stage_t;
```

That is not "real" RTL from the project, but it captures the feeling of the approach:

1. classify early
2. widen the significand a little
3. keep the exponent unbiased as soon as possible
4. carry special-case flags so later stages stay simple

### Alignment before addition

Addition is where the design stops feeling friendly. If exponents differ, one significand needs to be shifted right before the sum even makes sense.

\[
\text{sig}_{small,aligned} = \text{sig}_{small} \gg (E_{large} - E_{small})
\]

That line looks harmless, but it creates several design questions immediately:

- how wide should the aligned path be
- when do dropped bits become sticky
- how many guard bits do we need before rounding becomes trustworthy
- how do we stop a "simple" shifter from dominating the stage timing

<figure>
  <img src="/img/posts/waveform-lab.svg" alt="Placeholder waveform image">
  <figcaption>Another placeholder figure. This one stands in for the sort of waveform snapshot that usually explains more than three paragraphs of prose.</figcaption>
</figure>

## Normalization after the math

Once the adder or multiplier has produced a raw result, the pipeline still has cleanup work to do. In the happy path, normalization is just a one-bit shift. In the unhappy path, it becomes a small priority-encoder problem wrapped around edge-case handling.

The checklist I keep beside this stage usually looks like this:

- detect leading overflow after addition
- detect leading zeros after cancellation
- shift the significand into its normalized slot
- correct the exponent up or down
- preserve rounding information while shifting

### Cancellation is the rude case

If two nearly equal numbers subtract, the result can lose many leading bits at once. That means the data path needs a way to count leading zeros or to iteratively shift until the hidden bit is restored. Either approach is fine for a placeholder article, but it is exactly the kind of choice a real write-up should talk through clearly.

For a rough toy example, suppose the internal subtraction produces:

\[
0.00001101_2 \times 2^{12}
\]

Shifting left four places gives:

\[
1.101_2 \times 2^8
\]

The value is equivalent, but the exponent bookkeeping changed by four. That is the kind of detail that disappears if an article only shows the final answer.

## Rounding modes and boundary behavior

A lot of DIY floating-point experiments quietly pretend that truncation is "close enough." That is okay for a first smoke test, but not if the goal is to understand the format. Even a demo report benefits from spelling out the supported policy:

| Mode | Behavior | Implementation cost |
| --- | --- | --- |
| Round to nearest, ties to even | Best general default | Moderate |
| Toward zero | Easy to explain | Low |
| Toward `+\infty` | Needs sign awareness | Low |
| Toward `-\infty` | Needs sign awareness | Low |

The first implementation pass I would document here is:

- build only round-to-nearest-even
- keep guard, round, and sticky bits explicit in the stage record
- defer other modes until the reference tests already pass

### Weird values worth testing

The special cases are exactly where a long-form report becomes useful. A future real version of this page should probably include a small matrix like:

- `+0 + -0`
- `inf + finite`
- `inf + -inf`
- `nan + anything`
- smallest normal plus smallest denormal
- largest finite value plus a rounding carry

## Verification sketch

Even as dummy content, I want the report to feel like something you could build from. So here is the sort of verification outline I would expect in a genuine write-up:

1. start with a pure software model in Python or C
2. generate directed vectors for zeros, denormals, infinities, and NaNs
3. add random regression once the directed cases stop failing
4. save the failing seeds and waveforms immediately
5. compare intermediate pipeline stages, not just final outputs

<figure>
  <img src="/img/posts/cloud-fpga.svg" alt="Placeholder FPGA board image">
  <figcaption>This placeholder image stands in for board bring-up notes, measurement photos, or a "yes, it finally ran on hardware" victory screenshot.</figcaption>
</figure>

## What this dummy report is proving

This page is mostly here to test the shape of the blog, but that still tells us something useful:

- markdown headings can drive a real sidebar table of contents
- images break up dense text without fighting the theme
- code, tables, lists, and math can all live together on one page
- a technical article can be long without feeling visually flat

### A final toy example

If I wanted one compact expression that hints at the sort of hardware tradeoff this post is about, it would be the relationship between error and retained fraction bits:

\[
\varepsilon \approx 2^{-p}
\]

For single precision, \(p = 24\) if we count the implicit leading `1`, which means every decision about guard bits and sticky bits is really a decision about how faithfully we protect that effective precision through the pipeline.

## Next steps

The real version of this article would eventually replace every placeholder image here with actual figures, every "could" with measured results, and every toy equation with concrete test vectors. For now, it is enough that the post behaves like a real report: long, structured, navigable, and comfortable to read.
