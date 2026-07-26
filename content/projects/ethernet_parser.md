+++
title = "Ethernet Parser + Risk Pipeline"
date = 2026-07-26T09:00:00+01:00
description = "Implementing an Ethernet packet parser and risk pipeline"
cover = "/img/projects/ethernet_parser/ethernet_cables.jpg"
coverAlt = "Ethernet Cables"
coverClass = "article-cover--half"
cardClass = "content-card--small-media"
displayWords = 3760
tags = ["rtl", "fpga", "ethernet"]
math = true
toc = true
repoUrl = "https://github.com/R-Adoma/fpga_market_data_smartnic"
repoLabel = "GitHub repository"
+++

## Motivation

Earlier this year at university I took Digital System Design (banger module). In this class I learned about digital systems, how to optimise them, and the design considerations one takes when designing, amongst other things. The coup de grace for this module was trying to implement the evaluation of a complex function on a soft CPU with hardware accelerators, employing various techniques like loop unrolling and parallelism. It was a fun time seeing everyone try and push this project to the limit in all sorts of creative ways.

And clearly I haven't scratched that itch enough, so here we are. I wanted to develop some kind of hardware system and really try and optimise it for performance, and thought that a good real-world analogue for something like that would be delving a bit into the world of FPGAs in HFT (high-frequency trading). This eventually led me to settle on the title (hyperlinked) of this article.

## Specification + Research (or the lack thereof... haha)

When I decided to do this project I had a very rough idea of what I wanted to do: Ethernet parser + something else. That something else didn't get hashed out until way after I finished the Ethernet parsing part of the project.

### Thoughts on Ethernet Parsing Implementation

One of the main decisions I had to make was how faithfully or fully I would implement Ethernet parsing. Ethernet is a rather broad communication standard to implement in its totality. I'm going to discuss the horizontal and vertical complexities that a full implementation has. You could implement IPv4 and/or IPv6, UDP and/or TCP (and TCP is a beast in and of itself); these are the horizontal challenges. Vertically, it is the discussion of how low level the implementation should go. I was mainly weighing up implementing my own MAC or not. [brief explanation of MAC as well maybe its own section explaining what these concepts are] [Images of the communication standard]. The way I decided for myself what I was going to implement was by asking myself what I wanted to get out of this project, and what the design challenges were that I wanted to solve. This led me to using some external IP for the MAC and implementing an Ethernet/IPv4/UDP parser.

### The Something Else: Risk Engine

I did a bit of looking for the something else employed in the wild and came across things like full order books, risk engines, lightweight CNNs, diagnostics [check bc I'm bsing]. Each of these ideas had their merits and demerits but I personally settled on a risk engine, mainly because I felt like it was a problem with a rich design space and seemed both non-trivial and distinct enough from my previous work.

### Spec of Sorts

Granted, I had little more than "do A, do B, and hope they work" initially. As I got my hands in the proverbial mud and learned more about the system, various requirements began to materialise.

First of all, the boards I worked with had a 1 Gb/s Ethernet PHY. As a consequence, I decided that my Ethernet parsing path needed to be able to work at full load at line rate, and hence, with 8-bit data, would need to pass timing at 125 MHz.

After finishing the UDP parser and thinking about the second half of the project, I decided to adopt MoldUDP64/ITCH as the payloads for my packets.

Another self-imposed requirement was that the second part of the project would be implemented in a second clock domain. A: to challenge myself and learn to deal with CDC in a design. B: because there were practical benefits, i.e. being able to do the processing I wanted to before the next packet arrived.

So my spec ended up being:

- Ethernet RX path accepts at line rate
- Risk engine/TX path is fast enough to not stall/drop packets and can do the necessary computation
- CDC handling

## Part 1: RX Ethernet Packet Parsing

### System Diagram

<figure class="article-figure--medium">
  <img
    src="../../img/projects/ethernet_parser/rx_flow.png"
    alt="Rx Flowchart"
  >
  <figcaption>Flowchart showing the RX subsystem</figcaption>
</figure>

```text
RGMII pins
  -> verilog-ethernet MAC/RX FIFO
  -> smartnic_core
  -> logic_wrapper parser chain
  -> decision_event FIFO
  -> recovery_tracker / decision_controller
```

#### SmartNIC RX Parser Chain

- `SmartNIC/rtl/logic_wrapper.sv:136`
- `SmartNIC/rtl/axis_ingress_normalizer.sv`
- `SmartNIC/rtl/eth_parser.sv`
- `SmartNIC/rtl/ipv4_parser.sv`
- `SmartNIC/rtl/udp_parser.sv`
- `SmartNIC/rtl/feed_admission_filter.sv`
- `SmartNIC/rtl/udp_payload_extractor.sv`
- `SmartNIC/rtl/moldudp64_parser.sv`
- `SmartNIC/rtl/itch_parser.sv`
- `SmartNIC/rtl/mold_gap_detector.sv`
- `SmartNIC/rtl/rx_decision_event_adapter.sv`

#### RX Buffering / Recovery Side

- `SmartNIC/rtl/smartnic_async_fifo.sv`
- `SmartNIC/rtl/recovery_tracker.sv`

```text
eth_mac_inst RX FIFO
  -> smartnic_core
  -> logic_wrapper
  -> axis_ingress_normalizer
  -> eth_parser
  -> ipv4_parser
  -> udp_parser
  -> feed_admission_filter
  -> udp_payload_extractor
  -> moldudp64_parser
  -> itch_parser
  -> mold_gap_detector
  -> rx_decision_event_adapter
  -> u_decision_event_fifo
```

This section focuses on packet ingress: the story of what happens when we receive data on the PHY, all the way to it eventually sitting in the decision FIFO. The `smartnic_core` and `logic_wrapper` modules are high-level wrappers/integration that will be discussed later.

### Axis Ingress Normalizer

```text
MAC RX AXI-stream
  -> axis_ingress_normalizer
  -> internal parser pipeline
```

The AXI ingress normalizer acts as the receive-side boundary between the Ethernet MAC IP and the SmartNIC parsing pipeline. It converts the MAC-provided AXI-stream into a consistent internal byte-stream interface and initializes packet metadata used by later parser stages. This keeps the Ethernet/IP/UDP/MoldUDP64/ITCH parsers independent of the specific MAC implementation, improving modularity and making it easier to replace the MAC IP or modify the front-end interface later.

### Ethernet, IPv4, and UDP Parsers

I am talking about these three modules together because they all have very similar implementations, with a few differences due to the specifics of each of these headers. For this project I'm assuming a fixed, consistent Ethernet/IPv4/UDP header format, with the IHL in the IPv4 header being fixed. Fixing the IHL to 5 and choosing to only support UDP simplified the Ethernet parser a lot, since I knew what the relevant 42 bytes of Ethernet/IPv4/UDP headers would be ahead of time; incoming packets merely needed to pass certain checks like valid EtherTypes, header size, and no upstream errors to be valid. Each of these parsers passes a custom struct with its packet header info to the next.

### Feed Admission Filter

This will be expanded on later, but apart from market data packets, some of the hardware downstream can be configured by receiving configuration packets. There are two instances of this module: one lets packets with a destination port of 9000 (market) through and the other lets 9001 (config) through. Going for an approach like this avoids a more complicated routing/demux FSM at the cost of some resources. It would likely not scale well as a solution if I had a substantial number of paths I wanted to divert the payload down, but in this case I didn't, and due to me using the Nexys Video, utilization wasn't even remotely a concern. It is also fairly easy to extend if I wanted a third+ path.

### UDP Payload Extractor

This module acts as the header-stripping stage; it consumes the full packet stream and only re-emits the part the downstream parsers care about, which in this case is the UDP payload. This allows the downstream parsers to operate agnostic to what type of headers precede them, allows for modularity, and makes testing and reuse of the downstream parsers better.

### MoldUDP64 and ITCH

MoldUDP64 is the packet framing protocol used to carry market-data messages over UDP. Since UDP does not guarantee delivery or ordering, MoldUDP64 adds the sequencing information needed to detect missing, duplicate, or out-of-order packets. Each MoldUDP64 packet contains a session identifier, a packet sequence number, and a message count, followed by one or more length-prefixed application messages. In this project, the MoldUDP64 parser extracts the packet/session metadata, separates the individual messages, and provides sequence information to the gap detector so recovery can be triggered when packets are missed.

ITCH is the application-level market data protocol carried inside the MoldUDP64 messages. It describes exchange events such as add order, order executed, order cancelled, order deleted, and order replaced. Each ITCH message is a compact binary record with a message type and fixed-position fields such as timestamp, stock symbol, order reference number, side, shares, and price. In this project, the ITCH parser converts the raw byte stream into structured event metadata that the decision pipeline can use to update order state, maintain per-symbol totals, and evaluate trading/risk rules.

A concise way to describe the relationship is:

```text
Ethernet/IP/UDP = network transport
MoldUDP64       = market-data packet framing and sequencing
ITCH            = actual exchange event content
```

So MoldUDP64 tells you which messages arrived and whether any are missing. ITCH tells you what happened in the market.

### MoldUDP64 Parser

Its job is to:

- read the 10-byte session field
- read the 64-bit packet sequence number
- read the message count
- read each MoldUDP64 message length
- emit the contained ITCH message bytes as a clean stream
- produce metadata such as session, packet sequence, message sequence/index, message length, and parse-error status

### Mold Gap Detector

```text
seq == expected -> normal
seq > expected  -> gap, missing packets need recovery
seq < expected  -> duplicate/late packet
session changed -> feed state no longer trusted
parse error     -> malformed packet
```

This module tracks the feed sequence number. It maintains an expected next sequence number and compares each incoming packet's sequence number against it. If it is greater than expected, it reports a gap; if lower, it reports a duplicate or stale packet. It also tracks session changes and parser errors, as well as producing feed-health metadata which is acted on downstream.

### ITCH Parser

The ITCH parser decodes the application-level market data messages carried inside MoldUDP64 packets. It supports the subset of ITCH messages required by the prototype: system events, add orders, executions, executions with price, cancels, deletes, and replaces. For supported messages, it extracts the relevant order and symbol fields into a structured metadata record, including sequence number, message type, timestamp, order reference, side, shares, stock symbol, price, and executed shares. It also marks malformed or unsupported messages so the downstream decision logic can treat them safely rather than interpreting unknown data as a valid market event.

### TLDR on Market Stuff bc I Sure as Hell Didn't Know All These Terms Before Starting

- Order book
  - An order book is an exchange's live list of resting buy and sell orders for a symbol.
  - Buy side / bid side: people want to buy.
  - Sell side / ask side: people want to sell.
- Bid
  - A bid is a buy order. It represents someone willing to buy at a certain price.
  - Bid price = price buyer is willing to pay.
  - Bid size = number of shares/contracts wanted.
- Ask
  - An ask is a sell order. It says: "I want to sell this many shares at this price or higher." The lowest ask is the best price offered by sellers.
- Spread
  - The difference between the best ask and best bid.
  - `spread = best ask - best bid`
- Side
  - Determines whether an order is on the buy or sell side.
  - `B = buy / bid`
  - `S = sell / ask`
  - In ITCH Add Order messages, the side field tells whether a new order adds bid liquidity or ask liquidity.
- Liquidity
  - The available resting quantity in the book. If many shares are available near the best bid/ask, the market is more liquid.

### RX Decision Event Adapter

This module's job was to compress several separate RX-side signals into a single clean `decision_event_t` record. More specifically, it takes in:

- ITCH parser event
- Mold gap detector status
- feed healthy flag
- expected next sequence
- overflow flag

and produces:

- `decision_event_valid`
- `decision_event_out`

I guess the other thing to note here is that if there are multiple errors simultaneously, there is a priority encoder that prioritises errors that signify violations in trust/correctness.

### Recovery Tracker

This module exists to prevent the decision tracker from acting on out-of-order market data after a MoldUDP64 sequence gap.

It sits here:

```text
rx_decision_event_adapter
  -> event FIFO
  -> recovery_tracker
  -> decision_controller
```

Its job is to:

- detect gap consequences
- remember missing sequence numbers
- request recovery packets
- hold future events
- release recovered data in order
- fail closed if recovery becomes unsafe

#### Normal Case

If packets arrive in order:

```text
201, 202, 203, 204
```

then `recovery_tracker` mostly stays idle. Events pass through the normal path to the `decision_controller`.

#### Gap Case

If the design receives:

```text
201, 203
```

then the gap detector says:

```text
expected 202
got 203
missing 202
```

The recovery tracker then:

1. Adds 202 to its missing-sequence table.
2. Marks recovery as active.
3. Emits a recovery request for sequence 202.
4. Holds the future event 203 instead of allowing normal processing to continue freely.

Conceptually:

```text
missing table: [202]
hold table:    [203]
```

#### Recovery Packet Arrives

If the missing packet later arrives:

```text
202
```

then the tracker matches that event against the missing table:

```text
incoming seq 202 == missing seq 202
```

It marks sequence 202 as recovered, then outputs it through:

- `recovered_event_valid`
- `recovered_event`

The decision controller gives recovered events priority over normal events, so the missing packet is processed before later held future packets.

After that, the tracker can release held future data:

```text
process 202 first
then release 203
```

So the intended order becomes:

```text
201, 202, 203
```

even though hardware physically saw:

```text
201, 203, 202
```

#### Important Outputs

- `recovery_active`
  - Means the tracker is currently managing a gap.
- `freeze_normal_fifo`
  - Tells the core not to feed normal events directly into the decision controller while recovery is active.
- `recovery_request_valid`
- `recovery_request_seq`
  - Requests that the TX path emit a recovery request packet for a missing sequence.
- `recovered_event_valid`
- `recovered_event`
  - Sends a recovered event into the decision controller.
- `feed_unhealthy`
  - Raised when recovery becomes unsafe, for example overflow, too-large gap, parse error during recovery, or table exhaustion.

#### Tables Inside

The tracker has two small buffers:

- missing table, depth 8
- hold table, depth 8

The missing table stores sequence numbers that need retransmission. The hold table stores future events that arrived after the gap but before recovery completed.

That means the design supports short bounded recovery, not unlimited reordering.

#### Why It Exists

Without this module, if the feed skipped from 201 to 203, the decision logic might update state using 203 before seeing 202. That can corrupt the order book state, because market data is sequence-dependent.

The recovery tracker is the ordering guard. It says:

> If a gap happens, stop trusting future normal flow until the missing data is recovered or the feed is declared unhealthy.

#### Limitations

The current recovery depth is only 8, so it handles small gaps. A gap larger than 8 missing sequences fails closed.

Also, future events arriving continuously during recovery can fill the hold table. If recovery takes too long under line-rate traffic, the tracker will mark the feed unhealthy rather than risk incorrect state.

## Config Path

[Discuss config path]

## Part 2: TX Risk Engine

<figure class="article-figure--medium">
  <img
    src="../../img/projects/ethernet_parser/tx_flow.png"
    alt="Tx Flowchart"
  >
  <figcaption>Flowchart showing the TX subsystem</figcaption>
</figure>

### Decision Controller

The decision controller is a sequencing FSM that ensures correct event ordering, maintains order + symbol state through the cache/table submodules, evaluates reconfigurable risk thresholds after updates, and emits TX actions when needed (report an alert, recovery request, reset).

The flow of the FSM is generally as follows:

- `ST_IDLE`: wait for a safe event source
- `ST_DISPATCH`: classify RX status and ITCH message type
- `ST_CACHE_CMD` / `ST_WAIT_CACHE`: insert or lookup order cache entry
- `ST_CACHE_HIT_PREP`: compute applied shares and remaining shares
- `ST_CACHE_MAINT_CMD` / `ST_WAIT_CACHE_MAINT`: update/delete cache entry after cancel/execute/delete
- `ST_STATE_UPDATE` / `ST_WAIT_STATE`: update aggregate symbol state and capture new state
- `ST_RULE_READ` / `ST_WAIT_RULE`: read rule config for that symbol
- `ST_RULE_CHECK` / `ST_EVAL_RULE`: evaluate thresholds and decide alert/risk block/no action
- `ST_EMIT`: hold `tx_action_valid` until downstream accepts it

Rule checking used to be its own module but was then moved into the decision controller because it was relatively simple and made it easier to break down the combinational logic to resolve timing.

### Symbol State Table

It is a simple table that functions as a per-symbol aggregate state store. For each symbol, the following information is held:

- `symbol_id`
- `bid_live_shares`
- `ask_live_shares`
- `bid_added_shares`
- `ask_added_shares`
- `bid_cancelled_shares`
- `ask_cancelled_shares`
- `bid_executed_shares`
- `ask_executed_shares`
- `last_price`
- `last_event_ts`
- `event_count`
- `stale`
- `valid`

Then, based on update messages, those fields are updated. After an update, a snapshot of the new state is forwarded to the decision controller, which checks to see if the updated state violates any risk rules.

### Order-ID Cache

Functions as the controller's small memory for active orders. It is used so that the system can handle ITCH cancel, delete, and execute messages, which refer to existing orders by a reference ID rather than all the identifying information.

In the active controller instantiation, it is configured as:

```systemverilog
order_id_cache #(
    .SET_COUNT(8),
    .WAY_COUNT(4),
    .SYMBOL_INDEX_W(SYMBOL_INDEX_W)
) u_order_id_cache (...)
```

So in the controller it is an 8-set, 4-way set-associative cache, giving 32 cached orders.

The cache supports four operations:

- `LOOKUP`: search by `order_id`, return hit/miss and stored metadata
- `INSERT`: insert a new order, or overwrite the existing order if the same `order_id` already exists
- `UPDATE`: if hit, update `remaining_shares` only
- `DELETE`: if hit, invalidate the entry

And then in practice:

```text
Add watched order
  -> INSERT

Cancel/execute/delete
  -> LOOKUP
  -> compute applied shares and remaining shares
  -> UPDATE if shares remain
  -> DELETE if remaining shares becomes zero
```

This cache has an internal FSM of five stages, which helps break up logic and meet timing.

```text
ST_IDLE
  accept command

ST_READ_SET
  read all ways for selected set

ST_COMPARE
  compare tags, find hit or empty way

ST_APPLY
  produce response and perform insert/update/delete

ST_WAIT_RESP
  hold response until accepted
```

This cache employs a round-robin replacement strategy if all ways are full.

Safety behaviour:

- `cache_clear`
  - invalidate everything
- `cache_freeze`
  - block mutation, return `resp_blocked`

## Problems

The main implementation issue for this project was timing closure. Most of the design at the architectural level was relatively straightforward and didn't stump me for too long, and through a bit of thought and effort I managed to arrive at a satisfactory implementation that passed my unit and integration tests. The RX path converted Ethernet market data into ordered events, the controller updated an order cache and symbol table, and the rule logic generated alerts or risk blocks. However, the first versions of several blocks were too optimistic about how much combinational work could fit into one FPGA clock cycle. This was especially visible in the decision subsystem, where cache lookup, tag comparison, share arithmetic, rule threshold checks, recovery state, and TX action selection all interacted with relatively wide structs and high-fanout control signals.

To address timing, I decreased the frequency I had set for the decision subsystem from 200 MHz to 125 MHz, providing an extra 3 ns per cycle. I was comfortable doing this after doing some math (see below) to verify that the system could operate at line rate even with the decision subsystem at 125 MHz.

Besides that, I had to do a few other things to complete timing closure.

### Timing Closure Fixes

**Original issue:** One-cycle order-ID cache tried to read dynamic arrays, compare tags, choose a replacement way, generate write enables, and return a response in one path.

**Fix:** Serialize it into `READ_SET`, `COMPARE`, `APPLY`, and `WAIT_RESP` stages.

**Original issue:** Rule evaluation tried to go from updated symbol state through threshold comparisons and straight into TX action fields.

**Fix:** Register intermediate rule flags/results and evaluate them over multiple FSM states.

**Original issue:** Cache-hit handling calculated requested shares, applied shares, remaining shares, update/delete choice, and maintenance payload in one cycle.

**Fix:** Add `ST_CACHE_HIT_PREP` so the arithmetic happens after the cache response is captured.

**Original issue:** Recovery and debug logic created high-fanout and route-heavy paths.

**Fix:** Register recovery activity/request outputs, avoid clearing unused payload fields at runtime, and remove wide ILA/debug probes during timing runs.

## Throughput Calculations

At 1 Gb/s, the MAC-side datapath is 8 bits wide at 125 MHz.

If decision logic runs at 125 MHz, it has one cycle per received byte. If it runs at 200 MHz, it has:

```text
200 / 125 = 1.6 decision cycles per byte
```

In the case of an Add Order packet in the framework I am working with, the byte count is:

```text
Ethernet + IPv4 + UDP header = 42 bytes
MoldUDP64 header             = 20 bytes
Mold message length field    = 2 bytes
ITCH Add Order               = 36 bytes

Total AXI frame              = 100 bytes
```

On the wire, Ethernet also has FCS, preamble/SFD, and inter-frame gap:

```text
FCS      = 4 bytes
Preamble = 8 bytes
IFG      = 12 bytes

Wire overhead = 24 byte-times
```

So the full wire cost per tested packet is:

```text
100 + 24 = 124 byte-times
```

At 125 MHz:

```text
packet rate = 125e6 / 124
            ~= 1.008 million packets/s
```

A watched Add Order takes roughly 14 decision cycles:

```text
decision service rate = 125e6 / 14
                      ~= 8.93 million events/s
```

That is much faster than the input packet rate:

```text
1.008 M packets/s < 8.93 M events/s
```

For cancel/execute/delete cache hits, the service time is longer, about 20-22 cycles:

```text
125e6 / 22 ~= 5.68 million events/s
```

That is still above the representative one-event-per-packet input rate:

```text
1.008 M packets/s < 5.68 M events/s
```

This justifies the timing-closure approach: add pipeline stages, accept a few more cycles of latency, and keep the initiation/service rate comfortably above the traffic rate.

## Final System Diagram
<figure class="article-figure--medium">
  <img
    src="../../img/projects/ethernet_parser/rx_to_tx_flow.png"
    alt="Full RX to TX system flowchart"
  >
  <figcaption>Flowchart showing the full system</figcaption>
</figure>

## Reflections, Areas for Improvement, and Future Work

Another project finished. I'll take it. In terms of the chronology of this one, it followed the same pattern as most of my projects: an initial design push after a research phase, implement a bit, then fall off it for one reason or another. Then I resume it multiple times before eventually locking in and getting it over the line. A bit like how I read books now that I think about it.

Technically, I enjoyed this project. Working with a new interface, Ethernet, was cool, and thinking about what to do for the processing/TX side was fun as well. I settled on the risk pipeline because it felt bounded, had a rich enough design space, and gave me an excuse to do something interesting with state and memory.

If I return to this project, I would want to extend the functionality while keeping the line-rate guarantees. The main things I would look at are:

- Make recovery fully strict for gapped multi-message MoldUDP64 packets. Normal multi-message parsing works, and the decision path can consume multiple ITCH events, but packet-level gap status is generated at packet end. That means message events from a gapped packet may already have been emitted before the gap status is known.
- Fixing that properly would mean either determining Mold sequence status immediately after the Mold header, before emitting ITCH messages, or buffering all ITCH events from a Mold packet until the packet-level sequence status is known.
- Add more complex risk checks now that the timing and throughput margins are better understood.
- Potentially scale the order-ID cache and symbol/rule tables beyond the current small watched-symbol prototype.

Overall, the part I found most valuable was not just getting the parser to work, but learning how quickly a conceptually clean FPGA design can become difficult once timing closure, fanout, and routed paths become the real constraints.