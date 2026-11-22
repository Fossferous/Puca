/**
 * An SVG as a drawing program leaves one (Inkscape's own namespaces and
 * export path, RDF metadata, comments), with every way an SVG can act or
 * call out when opened as a document planted in it: script, event handlers,
 * HTML in a foreignObject that loads, runs or posts (an iframe, pictures, a
 * table's background, an object, a video's poster, a form, a link's ping, its
 * own style sheet and script) beside a label that must stay, an outside
 * picture and style sheet, CSS that names an address the way the engine
 * reads it but a plain search does not (`u\72l(`, `@\69mport "…"`,
 * `image-set("…")`), a javascript: link, animations that swap a link (one
 * under another prefix for XLink), xml:base, and the photo embedded again
 * claiming to be a GIF. The person and paths are made up. Every outside
 * address is on tracker.example or evil.example. Read by
 * tests/svgMetadata.test.ts and e2e/photo-metadata-real-browser.mjs (which
 * renders it, and needs `embedded` to be a real picture; nothing planted
 * changes what is drawn).
 */
export function inkscapeSvg(embedded: Uint8Array, embeddedType = 'image/jpeg'): string {
    let bin = '';
    for (let i = 0; i < embedded.length; i += 0x8000) bin += String.fromCharCode(...embedded.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) by SECRETCOMMENT-hello -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:cc="http://creativecommons.org/ns#" xmlns:html="http://www.w3.org/1999/xhtml"
     xmlns:q="http://www.w3.org/1999/xlink"
     width="64" height="48" viewBox="0 0 64 48"
     sodipodi:docname="logo-final.svg"
     inkscape:export-filename="/home/jane/Documents/logo-final.png"
     inkscape:version="1.3 (0e150ed6c4, 2023-07-21)"
     xml:base="https://evil.example/"
     onload="window.__svgRan = (window.__svgRan || 0) + 1; try { parent.postMessage('svg-script-ran', '*'); } catch (e) {}">
  <title>Hello drawing</title>
  <metadata>
    <rdf:RDF><cc:Work rdf:about=""><dc:creator><cc:Agent><dc:title>SECRETXMP-creator-jane</dc:title></cc:Agent></dc:creator></cc:Work></rdf:RDF>
  </metadata>
  <sodipodi:namedview pagecolor="#ffffff" inkscape:window-width="1920" inkscape:current-layer="layer1"/>
  <style>@import url("https://tracker.example/style.css"); @\\69mport "https://tracker.example/esc-import.css";
    .thick { stroke-width: 3; cursor: -webkit-image-set("https://tracker.example/wis.png" 1x), auto; }
    #layer1 { background-image: image-set("https://tracker.example/is.png" 1x); }</style>
  <defs>
    <linearGradient id="grad" x1="0" x2="1"><stop offset="0" stop-color="#c33"/><stop offset="1" stop-color="#36c"/></linearGradient>
    <circle id="dot" cx="0" cy="0" r="3" fill="#fff"/>
  </defs>
  <g inkscape:groupmode="layer" inkscape:label="Layer 1" id="layer1">
    <rect x="0" y="0" width="64" height="48" fill="url(#grad)"/>
    <rect x="4" y="4" width="20" height="14" fill="none" stroke="#000" class="thick" style="background: url(https://tracker.example/bg.png)"/>
    <rect x="4" y="4" width="20" height="14" fill="none" style="background-image: u\\72l(https://tracker.example/esc-bg.png)"/>
    <image x="30" y="4" width="16" height="12" href="data:${embeddedType};base64,${b64}"/>
    <image x="48" y="4" width="0" height="0" xlink:href="https://tracker.example/pixel.png"/>
    <image x="48" y="18" width="16" height="12" href="data:image/gif;base64,${b64}"/>
    <image x="0" y="0" width="0" height="0"><set attributeName="q:href" to="https://tracker.example/anim.png" begin="0s"/></image>
    <use href="#dot" x="10" y="38"/>
    <use xlink:href="https://evil.example/sprite.svg#a" x="20" y="38"/>
    <a href="javascript:alert(1)"><rect x="30" y="30" width="6" height="6" fill="#0a0" onclick="alert(2)"/></a>
    <a href="https://puca.example/about"><rect x="40" y="30" width="6" height="6" fill="#00a"/></a>
    <a href="#dot"><set attributeName="href" to="javascript:alert(3)" begin="0s"/></a>
    <foreignObject x="2" y="20" width="40" height="12"><html:div style="font: 7px sans-serif; color: #fff" onmouseover="alert(4)">Hi <html:b>there</html:b>
      <html:img src="https://tracker.example/fo-img.png" style="display:none"/><html:img srcset="https://tracker.example/fo-srcset.png 1x" style="display:none"/>
      <html:iframe src="https://tracker.example/fo-frame.html" style="display:none"></html:iframe>
      <html:div style="display:none; background: url(https://tracker.example/fo-bg.png)">x</html:div>
      <html:table background="https://tracker.example/fo-table.png" style="display:none"><html:tr><html:td>t</html:td></html:tr></html:table>
      <html:a href="https://puca.example/fo" ping="https://tracker.example/fo-ping">go</html:a>
      <html:script>window.__svgRan = (window.__svgRan || 0) + 1;</html:script>
      <html:style>@import url(https://tracker.example/fo-style.css);</html:style>
      <html:link rel="stylesheet" href="https://tracker.example/fo-link.css"/>
      <html:object data="https://tracker.example/fo-object" style="display:none"></html:object>
      <html:video poster="https://tracker.example/fo-poster.png" style="display:none"></html:video>
      <html:form action="https://tracker.example/fo-form" style="display:none"><html:input type="image" src="https://tracker.example/fo-input.png"/></html:form>
    </html:div></foreignObject>
    <script>window.__svgRan = (window.__svgRan || 0) + 1;</script>
  </g>
  <?inkscape-ruler SECRETCOMMENT-pi?>
</svg>
<!-- exported by SECRETCOMMENT-hello -->
`;
}

/** The few bytes of a font, as an SVG embeds one in its CSS. */
const b64Of = (b: Uint8Array): string => {
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(bin);
};

/**
 * A diagram as Mermaid, draw.io and Excalidraw export one, which is what
 * people send: Mermaid's node labels are HTML in a foreignObject (its default,
 * htmlLabels); draw.io's are a foreignObject in a `<switch>` whose plain
 * `<text>` fallback says only that the text cannot be shown; Excalidraw
 * embeds its fonts as `data:` URLs in an `@font-face`. `font` is a real font
 * (fixtures/metadata/box-font.ttf, whose A, B and C are solid shapes), so a
 * drawing that lost it is plainly different. draw.io draws its library
 * shapes (Azure, Kubernetes and the other `img/lib/*.svg` icons) as an
 * `<image>` of an SVG in a base64 `data:` URL, and an SVG put in a scene
 * comes out the same way; ICON is one, with what an editor leaves in it
 * (its export path, a comment), and ICON_PLAIN another, as a
 * percent-encoded URL. Nothing in it calls out or runs: cleaning it must
 * leave it drawn exactly the same.
 */
export const ICON = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: SECRETCOMMENT-icon -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="18" height="18" viewBox="0 0 18 18" inkscape:export-filename="/home/jane/icons/vm.png"><defs><linearGradient id="vm-g" x1="9" y1="13" x2="9" y2="2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0078d4"/><stop offset="1" stop-color="#5ea0ef"/></linearGradient></defs><rect x="1" y="2" width="16" height="11" rx="1" fill="url(#vm-g)"/><path d="M6 15h6v2H6z" fill="#32bedd"/></svg>`;
export const ICON_PLAIN = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><!-- SECRETCOMMENT-plain --><circle cx="9" cy="9" r="7" fill="#e3008c"/><path d="M5 9h8" stroke="#fff" stroke-width="2"/></svg>`;

/**
 * draw.io's own copy of the diagram, which it writes into the root's `content`
 * attribute when "Include a copy of my diagram" is ticked (so the file opens in
 * draw.io again), entity-escaped: its `<mxfile>` header says where it was drawn
 * (`host`: app.diagrams.net, Electron, a Confluence or Jira site), on what
 * (`agent`: the whole user agent) and when (`modified`). Made up, in its shape.
 */
export const DRAWIO_CONTENT = '&lt;mxfile host=&quot;Electron&quot; modified=&quot;2026-11-20T09:14:03.512Z&quot; '
    + 'agent=&quot;Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) draw.io/24.7.17 Chrome/128.0.6613.36 Electron/32.0.1 Safari/537.36&quot; '
    + 'etag=&quot;SECRETETAG-k3J9&quot; version=&quot;24.7.17&quot; type=&quot;device&quot;&gt;&lt;diagram name=&quot;Page-1&quot; id=&quot;SECRETDIAGRAM-id&quot;&gt;'
    + '&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;';

/**
 * ...with what else an editor leaves on its shapes: Mermaid 11's `data-look`
 * and `data-id` and its own `label-offset-x`, none of them anything SVG
 * defines. One `data-*` attribute, `data-tone`, is one the drawing's own style
 * sheet selects on (no editor named: a drawing may), so it is part of how the
 * drawing looks and must stay.
 */
export function diagramSvg(font: Uint8Array): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="160" height="80" viewBox="0 0 160 80" style="background-color: white;" content="${DRAWIO_CONTENT}">
  <style>@font-face { font-family: "Box"; src: url(data:font/ttf;base64,${b64Of(font)}); }
    .excalidraw { font-family: "Box"; font-size: 16px; fill: #1e1e1e; }
    .node rect { fill: #ececff; stroke: #9370db; }
    .node[data-tone="warm"] rect { fill: #ffe4cc; stroke-width: 3px; }</style>
  <g class="node" data-look="classic" data-id="A" label-offset-x="0" data-tone="warm"><rect x="2" y="2" width="76" height="30"/>
    <foreignObject x="2" y="2" width="76" height="30"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap; width: 76px; height: 30px; text-align: center; vertical-align: middle; font: 12px sans-serif; color: #333;"><span class="nodeLabel"><p style="margin: 0;">Start <b>here</b></p></span></div></foreignObject></g>
  <switch><foreignObject x="82" y="2" width="76" height="30" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility" style="overflow: visible; text-align: left;"><div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: center; justify-content: center; width: 76px; height: 30px; background: #fff2cc; font: 11px sans-serif; color: #000;"><div style="display: inline-block; white-space: normal;">Decide</div></div></foreignObject><text x="120" y="20" font-size="9" text-anchor="middle">Text is not SVG - cannot display</text></switch>
  <text x="6" y="66" class="excalidraw">ABC ACB</text>
  <g class="drawio-shape"><image x="118" y="44" width="18" height="18" xlink:href="data:image/svg+xml;base64,${b64Of(new TextEncoder().encode(ICON))}" preserveAspectRatio="none"/></g>
  <image x="140" y="44" width="18" height="18" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(ICON_PLAIN)}"/>
</svg>`;
}
