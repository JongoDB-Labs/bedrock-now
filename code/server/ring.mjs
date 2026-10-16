// A session's recent events, numbered 1, 2, 3 …, for re-attaching pages (a reload, a second tab, a phone). Bounded by
// count and by size; consecutive streaming deltas are not kept one by one once their block is finished (the
// finished text/thinking event carries the same text), so a long answer costs its size once.

export class Ring {
  constructor({ maxItems = 4000, maxBytes = 8 << 20 } = {}) {
    this.maxItems = maxItems; this.maxBytes = maxBytes;
    this.items = [];   // [{seq, ev, size}]
    this.bytes = 0; this.seq = 0;
  }

  push(ev) {
    const seq = ++this.seq;
    const size = JSON.stringify(ev).length;
    // a finished block replaces the deltas that streamed it (still numbered: their seqs simply go missing)
    if (ev.type === 'text' || ev.type === 'thinking') {
      const delta = ev.type === 'text' ? 'delta' : 'thinking_delta';
      while (this.items.length && this.items[this.items.length - 1].ev.type === delta) this.bytes -= this.items.pop().size;
    }
    this.items.push({ seq, ev, size });
    this.bytes += size;
    while (this.items.length > 1 && (this.items.length > this.maxItems || this.bytes > this.maxBytes)) this.bytes -= this.items.shift().size;
    return seq;
  }

  get first() { return this.items.length ? this.items[0].seq : this.seq + 1; }
  get last() { return this.seq; }

  // since(n) -> {events: [{seq, ev}] after n, gap: whether events after n were dropped (re-read the history)}
  since(n = 0) {
    const after = Number.isInteger(n) && n > 0 ? n : 0;
    const events = this.items.filter((x) => x.seq > after).map(({ seq, ev }) => ({ seq, ev }));
    return { events, gap: after + 1 < this.first && this.seq > after };
  }
}
