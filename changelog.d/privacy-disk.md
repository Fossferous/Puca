### Security

- **Videos, GIFs, TIFFs, HEIC and AVIF photos and SVG drawings lose their hidden details before they are sent.**
  Until now only JPEG, PNG and WebP photos had their location, camera and time taken off. Now a
  phone video's recording place, camera and date (MP4, MOV, WebM, MKV), a GIF's comments and
  XMP, a TIFF's camera and GPS tags, a HEIC or AVIF photo's EXIF and XMP, and an SVG's editor
  notes, file path and anything in it that would run or reach out when it is opened go too. The
  picture or the video itself is not re-encoded: it is the same, frame for frame, and a drawing
  keeps its labels and embedded fonts (a Mermaid, draw.io or Excalidraw diagram looks the same
  wherever it is opened). A file that
  claims to be one of these but cannot be read is not sent, and its chip says why. Comes with
  the update.
- **Pictures waiting to be sent no longer stay on your disk after you stop looking at them.**
  A Púca Notes picture still waiting for a connection, a picture pasted into the message box,
  and a clip you save with Download could stay on the device's storage, unencrypted, for some
  time after nothing showed them. Now they go within seconds of being closed, sent or saved,
  and the desktop app saves a clip without that extra copy at all. Comes with the update.
