+++
title = "Side Channels"
date = 2026-04-12T09:00:00+01:00
description = "Exploring correlation power analysis and masking countermeasures on an AES-128 RTL implementation"
cover = "/img/projects/sidechannel/sidechannelmain.png"
coverAlt = "Side-channel attack visual"
displayWords = 1023
tags = ["rtl", "cyber-security", "notes"]
math = true
toc = true
repoUrl = "https://github.com/R-Adoma/aes_128"
repoLabel = "GitHub repository"
+++

## Motivation

This is a project in which I wanted to explore some hardware security, so I decided to return to a concept I had learned about in computer architecture: side channels. In this project, I try to exploit and defend against them.

## What Is a Side Channel?

A side channel is any shared state, measurement, or piece of information that reveals something we would ideally like to keep secret. In a CPU, this could mean learning which cache lines have been touched or evicted through well-known cache-timing attacks such as Prime+Probe or Flush+Reload.

## The Victim: AES-128

AES-128, or Advanced Encryption Standard with a 128-bit key, is a symmetric block cipher. It encrypts a 128-bit plaintext block into a 128-bit ciphertext block using a 128-bit secret key. The same key is used for decryption, so security depends on keeping that key secret.

AES represents the 128-bit block as a 4x4 matrix of bytes called the state. Encryption starts by XORing the plaintext state with the initial round key. This is called `AddRoundKey`.

```text
state = plaintext ^ key
```

After that, AES-128 performs 10 rounds of transformation. Rounds 1 through 9 contain four main steps:

```text
SubBytes
ShiftRows
MixColumns
AddRoundKey
```

The final round skips MixColumns, so it only performs:

```text
SubBytes
ShiftRows
AddRoundKey
```

The four transformations are:

- SubBytes: replaces each byte using the AES S-box. This provides nonlinearity.
- ShiftRows: rotates rows of the state matrix to spread bytes across columns.
- MixColumns: mixes bytes within each column using finite-field arithmetic. This provides diffusion.
- AddRoundKey: XORs the current state with a round key derived from the original key.

The round keys are produced by the AES key schedule. For AES-128, the original 128-bit key is expanded into 11 round keys: one for the initial AddRoundKey and one for each of the 10 rounds.

From a cryptographic perspective, AES-128 is secure when implemented correctly. However, this project is focused on implementation leakage rather than breaking the AES algorithm itself. The attack does not exploit a mathematical weakness in AES. Instead, it exploits the fact that hardware power consumption can depend on intermediate values such as:

```text
plaintext ^ key
```
That value is a normal part of AES, but if it is stored or switched directly in hardware, it can create a side channel that leaks information about the secret key.





## Setup

To approximate an oscilloscope-style power measurement, I ran the AES RTL simulation, generated a VCD waveform, and converted selected switching activity into a single scalar leakage trace. For each sample, the trace generator summed the bit transitions across selected design signals, added Gaussian noise, and saved the result as the attacker-facing "power" trace.

The goal was not to give the attacker direct access to internal RTL values, but to approximate what a physical attacker might observe: a noisy aggregate measurement correlated with hardware switching activity.

The aggregate leakage model used the following dumped signals:

```systemverilog
$dumpvars(0, tb_aes_trace.clk);
$dumpvars(0, tb_aes_trace.rst_n);
$dumpvars(0, tb_aes_trace.start);
$dumpvars(0, tb_aes_trace.valid);
$dumpvars(0, tb_aes_trace.dut.state_reg);
$dumpvars(0, tb_aes_trace.dut.ciphertext);
$dumpvars(0, tb_aes_trace.dut.u_ctrl.cur_state);
$dumpvars(0, tb_aes_trace.dut.u_ctrl.round_counter);
$dumpvars(0, tb_aes_trace.dut.u_key_expansion.round_keys_flat);
$dumpvars(0, tb_aes_trace.dut.u_key_expansion.ready);
```


## CPA

Correlation Power Analysis (CPA) is a statistical side-channel attack that tries to recover secret data by comparing measured power traces against predicted leakage. The attacker guesses part of the key, computes an intermediate value that would occur inside the cipher for that guess, converts that value into a leakage estimate such as Hamming weight or Hamming distance, and then correlates that estimate with the measured traces. The correct key guess should produce the strongest correlation because its predicted leakage matches the real key-dependent switching activity in the hardware.


## Attacks

Well, the bitter truth of security is that as a defender you have to win every time, but as an attacker I only need to win once. Yada yada.

### Data + Insights

<figure>
  <img src="../../img/projects/sidechannel/accuracy_vs_traces.png" alt="Plot showing two CPA models versus trace count and accuracy">
  <figcaption>First-order CPA accuracy against the unmasked AES implementation as the number of traces increases.</figcaption>
</figure>

The plot above offers a few interesting insights. One is that:
> *The leakage model mattered much more than trace granularity in this experiment.*

We see that the textbook `s_box` model fails pretty miserably. This is because it models the wrong internal event. The `xor` model works because it correctly matches the initial registered state load.

### The Vulnerability

The vulnerable line is `state_reg <= plaintext ^ key;`.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        state_reg <= '0;
    end else if (start) begin
        state_reg <= plaintext ^ key;
    end
end
```

`state_reg` is one of the signals included in the aggregate switching activity used as the mock oscilloscope reading. Since the attacker knows the plaintext, the transition `state_reg <= plaintext ^ key` creates a direct key-dependent leakage point. With enough traces to average down noise, the `xor_hw` leakage model can statistically recover the key through CPA.

This is an important implementation lesson: the key can leak before the AES round machinery even begins. In this design, the first exploitable side channel was not the S-box output, but the initial AddRoundKey state transition. I included this result to show how easy it is for a cryptographically correct RTL design to still be vulnerable at the implementation level.


## Improving on AES-128

There are a few ways to address that vulnerability, most of which fall into two broad categories: `hiding` and `masking`.

### Hiding

This is where we make the leakage harder to distinguish, perhaps by adding extra noise.

### Masking

This is the process of changing what is stored or switched so that the leakage is no longer solely dependent on the secret alone.

I decided to explore whether employing a basic masking scheme could defend against the first-order CPA attack.

## V2 (Masked S-Box)

V1 leaked because the initial AES state was stored directly:

```systemverilog
state_reg <= plaintext ^ key;
```

Since the attacker knows the plaintext, this gave the `xor_hw` CPA model a clean target. In V2, the state is masked before it is stored:

```systemverilog
state_masked_reg <= plaintext ^ key ^ initial_mask_vec;
```

So the stored value is now:

```systemverilog
state_masked = state ^ mask
```

Because the mask changes for each trace and is unknown to the attacker, the register load no longer has a stable first-order relationship with `plaintext ^ key`. This is intended to break the original `xor_hw` attack.

The linear AES transformations are straightforward to handle because they preserve XOR masking:

```systemverilog
ShiftRows(state ^ mask) = ShiftRows(state) ^ ShiftRows(mask)
MixColumns(state ^ mask) = MixColumns(state) ^ MixColumns(mask)
```

`AddRoundKey` is also straightforward:

```systemverilog
(state ^ mask) ^ round_key = (state ^ round_key) ^ mask
```

The only difficult step is SubBytes, because the S-box is nonlinear:

```systemverilog
SBox(state ^ mask) != SBox(state) ^ SBox(mask)
```

To handle this, V2 uses a masked S-box that converts from the current mask to the next mask. If the input byte is:

```text
x_masked = x ^ current_mask
```

then the output should be:

```text
SBox(x) ^ next_mask
```

In the RTL this is implemented as:

```systemverilog
after_subbytes_masked[row][col] =
    sbox[state_masked_in[row][col] ^ current_mask[row][col]] ^
    next_subbytes_mask[row][col];
```
This removes the current mask for the lookup, applies the S-box, and immediately applies the next mask. The AES state therefore remains masked through the round function, and the final state is only unmasked when producing the public ciphertext. This is enough for the simplified first-order model here, although a production masked S-box would need to avoid leaking the unmasked intermediate inside the lookup logic.

### Performance

<figure>
  <img src="../../img/projects/sidechannel/accuracy_vs_traces_masked.png" alt="Plot showing two CPA models versus trace count and accuracy">
  <figcaption>First-order CPA accuracy against the masked AES implementation as the number of traces increases.</figcaption>
</figure>

I applied the same attack that cracked version 1 of the AES-128 implementation, and as the figure above illustrates, it fails to extract the key from the masked version.

Both first-order CPA models, `xor_hw` and `sbox_hw`, remain near zero recovered bytes even as the number of traces increases to 5000. This is the intended result: the original leakage model no longer matches the values being stored and switched in the masked datapath. In V1, the attacker could correlate against `plaintext ^ key`; in V2, that value is randomized by a fresh mask for each trace.

This does not prove that the masked implementation is fully side-channel secure. It only shows that the demonstrated first-order CPA attacks no longer work under this simulated aggregate power model. A stronger attacker could still attempt higher-order analysis, glitch-aware attacks, or attacks using a richer leakage model.

## Outro

So this brings an end to my brief gander into side channels in hardware. I found this project to be an interesting look into how much information about the underlying hardware implementation can be gleaned through even limited knowledge of a system's behavior. This project was also one of the first major steps I've taken in dabbling with cryptography beyond a basic Caesar cipher, and I'm eager to explore more of the field and its challenges.

## Potential Extensions
- other attacks
- other encryption standards
- take this physical and use an oscilloscope; this will add noise, make the process longer, and require consideration of real-life measurement impediments.















































<!-- Also talk about the costs in hardware of making a more secure design ? -->
<!-- I think the interview story here is not “I implemented AES.” The interesting story is:

I built a simulation-based side-channel evaluation flow for RTL crypto, then used it to show how leakage models, trace resolution, and statistical correlation affect key recovery.

That gives you several good discussion points.

Threat Model
You can talk about why you did not attack raw VCD internals directly.

That is a strong point:

A real attacker does not see state_reg or S-box outputs.
They see a scalar power/EM trace.
So you converted VCD activity into aggregate noisy traces.
You separated full internal datasets from attacker-facing datasets.
That is a real security-engineering decision.

Leakage Modeling
This is probably the best discussion area.

You tried:

textbook HW(SBox(pt ^ k))
implementation-matched HW(pt ^ k) / HD(0, pt ^ k)
The first failed. The second worked.

That is a great lesson:

side-channel attacks are not plug-and-play
success depends on matching the model to the implementation
the RTL microarchitecture determines what leaks
That is interview-worthy because it shows debugging and reasoning, not just running CPA.

Statistical Method
You found that abs(corr) created a complement ambiguity.

That’s another nice discussion:

signed correlation mattered
bitwise complements can produce equal-magnitude opposite-sign correlation
scoring details affect recovery
looking at top guesses helped diagnose the issue
That is more subtle than it seems.

Measurement Granularity
You explored coarse vs high-resolution traces.

You can say:

Coarse 14-sample traces already captured the leakage event.
High-res 137-sample traces did not dramatically improve recovery.
This suggests sampling rate helps mainly when the leakage timing is unknown or smeared.
Once the point of interest is captured, model quality matters more than raw trace length.
That is a meaningful experimental result.

Trace Count
Accuracy vs number of traces is also a good talking point.

You can say:

With too few traces, random correlation peaks dominate.
Around 1500 traces, the correct key emerged reliably.
This demonstrates the statistical nature of CPA.
That helps explain why side channels are probabilistic, not deterministic.

RTL Security Improvements
The next phase adds the engineering tradeoffs you feel are missing.

Once you add countermeasures, you can discuss:

masking vs hiding
where to add randomness
whether to register S-box outputs
whether a countermeasure defeats first-order CPA only
cost in area/latency/randomness
what attacks still remain
That becomes much closer to the CNN-style “decisions/tradeoffs” space.

So I’d frame the project in interviews like this:

“I built an AES-128 RTL core, then built a realistic attacker-facing trace pipeline from VCD switching activity. A naive textbook CPA model failed, so I investigated leakage-model mismatch, changed the model to match the RTL’s registered state transition, fixed a signed-correlation issue, and recovered the full key. I then used plots to study trace count, model choice, and sampling resolution.”

That is a strong story.

It is less flashy than “CNN on FPGA,” but it has a different kind of maturity: it shows you can build a system, define a threat model, diagnose failed experiments, and reason statistically about hardware security. -->




