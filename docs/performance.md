# Performance

Measured on 2026-11-08 on the author's Mac (10 cores, APFS, home folder with 335 GB / 823k Disk Map nodes), with
`scripts/measure.sh`. Everything is read-only. Numbers depend on the disk and on how many files the home holds;
use them to compare changes on the same machine, not across machines.

## Scanners (release build, warm file-system cache)

| Scanner | Time | Peak memory before | Peak memory now |
| --- | --- | --- | --- |
| Junk | 0.5 s | 17 MB | 17 MB |
| Large files (≥ 50 MB) | 4.8 s | 177 MB | 54 MB |
| Duplicates (≥ 1 MB) | 6.6 s | 193 MB | 63 MB |
| Disk Map (whole home) | 28.9 s | 455–521 MB | 285 MB |

The memory drop comes from walking with detached entries: a `std::fs::DirEntry` keeps its directory stream open,
and the walkers held a directory's entries while recursing into it, so every open level of every parallel walk
kept a stream and its buffer alive.

The Disk Map is bound by system calls, not by our code: 28 s of wall time are 6 s of user time and 145 s of kernel
time, and kernel time grows with the thread count (59 s with 2 threads, 145 s with 10) while wall time still drops
(68 s → 28 s). The next step, if it matters, is enumerating with `getattrlistbulk(2)`, which returns names and
sizes for a batch of entries in one call instead of one `lstat` per entry.

## The app

Main process plus the WebKit processes it starts (the page renders in WebKit's own processes):

| State | CPU (avg) | Memory |
| --- | --- | --- |
| Focused, idle (steady state) | 0.1–1.1 % | ≈ 230 MB (105 MB app + WebKit) |
| In the background | 0.0 % | ≈ 220 MB |

The first seconds after launch average about 5 % CPU while the window paints. Continuous animations pause when the
window loses focus, which is why the background state is at zero.
