/**
 * An SVG as a drawing program leaves one (Inkscape's own namespaces and
 * export path, RDF metadata, comments), with every way an SVG can act or
 * call out when opened as a document planted in it: script, event handlers,
 * a foreignObject, an outside picture and style sheet, a javascript: link,
 * an animation that swaps a link, xml:base. The person and paths are made
 * up. Read by tests/svgMetadata.test.ts and e2e/photo-metadata-real-browser.mjs
 * (which renders it, and needs `embedded` to be a real picture).
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
  <style>@import url("https://tracker.example/style.css"); .thick { stroke-width: 3; }</style>
  <defs>
    <linearGradient id="grad" x1="0" x2="1"><stop offset="0" stop-color="#c33"/><stop offset="1" stop-color="#36c"/></linearGradient>
    <circle id="dot" cx="0" cy="0" r="3" fill="#fff"/>
  </defs>
  <g inkscape:groupmode="layer" inkscape:label="Layer 1" id="layer1">
    <rect x="0" y="0" width="64" height="48" fill="url(#grad)"/>
    <rect x="4" y="4" width="20" height="14" fill="none" stroke="#000" class="thick" style="background: url(https://tracker.example/bg.png)"/>
    <image x="30" y="4" width="16" height="12" href="data:${embeddedType};base64,${b64}"/>
    <image x="48" y="4" width="0" height="0" xlink:href="https://tracker.example/pixel.png"/>
    <use href="#dot" x="10" y="38"/>
    <use xlink:href="https://evil.example/sprite.svg#a" x="20" y="38"/>
    <a href="javascript:alert(1)"><rect x="30" y="30" width="6" height="6" fill="#0a0" onclick="alert(2)"/></a>
    <a href="https://puca.example/about"><rect x="40" y="30" width="6" height="6" fill="#00a"/></a>
    <a href="#dot"><set attributeName="href" to="javascript:alert(3)" begin="0s"/></a>
    <foreignObject x="0" y="0" width="10" height="10"><html:div style="display:none">SECRETCOMMENT-hidden</html:div></foreignObject>
    <script>window.__svgRan = (window.__svgRan || 0) + 1;</script>
  </g>
  <?inkscape-ruler SECRETCOMMENT-pi?>
</svg>
<!-- exported by SECRETCOMMENT-hello -->
`;
}
