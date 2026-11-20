### Fixed

- **Show Stream Stats says when a picture is frozen.** When a stream you were
  watching stood still while its sound kept playing, the readout went on
  saying "0 freezes" the whole time, because a freeze is only counted once
  the picture moves again. Now, while the picture is frozen and the stream is
  still arriving, that row reads "Frozen for 12 s" and counts up; once the
  picture moves, the dropped frames and freezes are back as before. A sharer
  who stops sending is not called frozen once nothing more is arriving, and
  a camera turned off or a slow share of a still screen is not called frozen
  at all. This comes with the update; no new install is needed.
