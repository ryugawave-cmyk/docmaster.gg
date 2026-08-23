# Hero particle background — media

The homepage hero has a **decorative particle background** behind the illustration
(right column). It has two layers, so it looks good with or without a video file:

1. **CSS particle field** (`.hero-particles__field`) — a lightweight, always-on
   animation (no video needed, no per-frame JavaScript). This is what you see now.
2. **Optional particle video** (`.hero-particles__video`) — an easily replaceable
   slot. Drop real files here and they fade in automatically over the CSS field.

## To add your own particle video

Place the exported files in this folder using these exact names:

- `hero-particles.webm`  (preferred — VP9/AV1, small + efficient)
- `hero-particles.mp4`   (H.264 fallback for Safari/older browsers)
- `hero-particles-poster.svg` or `.jpg` (the poster/still — one is already here)

That's it — no code change required. `main.js` reveals the video only once it is
actually playing, and `views/pages/home.ejs` already wires `muted` / `loop` /
`playsInline` / `preload="none"` with **no controls and no audio**.

### Recommended encode (keep it subtle + fast)

- Resolution: ~1280×800 (it's `object-fit: cover`, cropping is fine)
- Duration: 8–15 s, **seamless loop** (no hard cut)
- Bitrate: low — this is a faint background; aim for a small file (< ~1.5 MB)
- Content: small glowing lavender/blue particles, slow elegant drift, gentle depth
- No large/bright flashes, no text, no logos

### Behaviour already handled

- **Autoplay, muted, loop, playsInline**, no controls, no audio.
- **`prefers-reduced-motion`** → the video does not play; the static particle
  field (poster equivalent) is shown instead.
- **Responsive** → density/opacity reduced on tablet; video disabled on mobile.
- **`pointer-events: none`** → never blocks text, buttons, links or navigation.
