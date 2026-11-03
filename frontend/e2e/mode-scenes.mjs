// Pictures for the server-mode look's checks (docs/SERVER_MODES.md), drawn from nothing so that
// no image has to be committed and none belongs to anyone. Each is run in a page, and answers
// a JPEG as base64, as a person's upload would be.
//
//   daylight   a bright landscape: the case the old veil turned grey
//   balloons   saturated mid-tones
//   night      dark, with one bright moon, which should cost only the moon
//   snow       nearly white: the hardest on a dark theme, the easiest on Light
//   busy       thousands of small bright shapes: the hardest to read text over
//   lines      thin white lines on black: the most a JPEG's ringing can do near the limit
export const SCENES = ['daylight', 'balloons', 'night', 'snow', 'busy', 'lines'];

export function drawScene(name) {
    const W = 1600;
    const H = 900;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    // The same picture every run.
    let seed = 20261102;
    const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const vertical = (stops) => {
        const v = g.createLinearGradient(0, 0, 0, H);
        stops.forEach(([at, colour]) => v.addColorStop(at, colour));
        g.fillStyle = v;
        g.fillRect(0, 0, W, H);
    };
    const disc = (x, y, r, colour) => {
        g.fillStyle = colour;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
    };
    const ridge = (base, swing, wave, colour, phase = 0) => {
        g.fillStyle = colour;
        g.beginPath();
        g.moveTo(0, H);
        for (let x = 0; x <= W; x += 8) {
            g.lineTo(x, base + Math.sin(x / wave + phase) * swing + Math.sin(x / (wave * 0.37) + phase) * swing * 0.3);
        }
        g.lineTo(W, H);
        g.fill();
    };
    const peaks = (base, height, count, colour) => {
        g.fillStyle = colour;
        g.beginPath();
        g.moveTo(0, base);
        for (let i = 0; i <= count; i++) {
            const x = (i / count) * W;
            g.lineTo(x, base - (i % 2 === 0 ? height * (0.6 + rnd() * 0.4) : height * rnd() * 0.3));
        }
        g.lineTo(W, base);
        g.fill();
    };
    const tree = (x, y, size, leaf, trunk) => {
        g.fillStyle = trunk;
        g.fillRect(x - size * 0.08, y, size * 0.16, size * 0.5);
        g.fillStyle = leaf;
        for (let i = 0; i < 3; i++) {
            g.beginPath();
            g.moveTo(x - size * (0.55 - i * 0.1), y - i * size * 0.32 + size * 0.1);
            g.lineTo(x, y - (i + 1) * size * 0.42);
            g.lineTo(x + size * (0.55 - i * 0.1), y - i * size * 0.32 + size * 0.1);
            g.fill();
        }
    };

    if (name === 'daylight') {
        vertical([[0, '#3d9bf0'], [0.55, '#bfe6ff']]);
        disc(1290, 150, 150, 'rgba(255, 244, 190, 0.35)');
        disc(1290, 150, 82, '#fff8d8');
        for (const [cx, cy, s] of [[280, 170, 1.2], [760, 110, 0.9], [1050, 260, 0.7], [90, 330, 0.7]]) {
            for (let i = 0; i < 11; i++) disc(cx + (i - 5) * 42 * s, cy + Math.sin(i * 1.7) * 24 * s, (60 - Math.abs(i - 5) * 6) * s, '#ffffff');
        }
        peaks(600, 300, 13, '#7d9cc0');
        ridge(610, 34, 210, '#67b84c');
        ridge(690, 40, 300, '#3f9d3c', 1.4);
        g.fillStyle = '#2e88d8';
        g.fillRect(0, 780, W, 120);
        for (let i = 0; i < 90; i++) {
            g.fillStyle = rnd() > 0.5 ? '#7cc3f2' : '#1f6fbe';
            g.fillRect(rnd() * W, 785 + rnd() * 112, 40 + rnd() * 90, 3);
        }
        for (let i = 0; i < 26; i++) tree(40 + rnd() * W, 640 + rnd() * 90, 60 + rnd() * 50, rnd() > 0.5 ? '#1f7a33' : '#2a8f3c', '#6b4423');
        g.fillStyle = '#f4efe4';
        g.fillRect(620, 590, 240, 150);
        g.fillStyle = '#c8321f';
        g.beginPath();
        g.moveTo(590, 595);
        g.lineTo(740, 480);
        g.lineTo(890, 595);
        g.fill();
        g.fillStyle = '#6b4423';
        g.fillRect(715, 660, 50, 80);
        g.fillStyle = '#4aa3f0';
        g.fillRect(650, 625, 44, 44);
        g.fillRect(786, 625, 44, 44);
    } else if (name === 'balloons') {
        vertical([[0, '#2f7f95'], [0.45, '#b98fa8'], [0.8, '#e58a4e'], [1, '#a4492e']]);
        for (let i = 0; i < 4; i++) ridge(650 + i * 60, 30, 170 + i * 40, ['#8a5a7a', '#6d4f77', '#58426a', '#3d3158'][i], i);
        const paints = [['#d72638', '#f7b32b'], ['#1b998b', '#f4e04d'], ['#7b2cbf', '#ff6d00'], ['#e0218a', '#2d7dd2'], ['#ef8a17', '#3a7d44'], ['#2d7dd2', '#f1f7ed']];
        [[230, 300, 118], [560, 200, 84], [840, 360, 140], [1140, 170, 96], [1400, 340, 122], [1010, 610, 62]].forEach(([x, y, r], i) => {
            const [a, b] = paints[i];
            disc(x, y, r, a);
            g.fillStyle = b;
            for (let s = -2; s <= 2; s += 2) {
                g.beginPath();
                g.ellipse(x + (s * r) / 3.2, y, r / 7, r * 0.98, 0, 0, Math.PI * 2);
                g.fill();
            }
            g.strokeStyle = '#3a2a22';
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(x - r * 0.45, y + r * 0.9);
            g.lineTo(x - r * 0.18, y + r * 1.5);
            g.moveTo(x + r * 0.45, y + r * 0.9);
            g.lineTo(x + r * 0.18, y + r * 1.5);
            g.stroke();
            g.fillStyle = '#6b4423';
            g.fillRect(x - r * 0.2, y + r * 1.5, r * 0.4, r * 0.3);
        });
    } else if (name === 'night') {
        vertical([[0, '#05071a'], [1, '#1c1a40']]);
        for (let i = 0; i < 420; i++) {
            const b = 120 + Math.floor(rnd() * 135);
            g.fillStyle = `rgb(${b},${b},${Math.min(255, b + 30)})`;
            g.fillRect(rnd() * W, rnd() * 560, 2, 2);
        }
        disc(1210, 200, 165, 'rgba(244, 239, 216, 0.08)');
        disc(1210, 200, 100, '#f4efd8');
        disc(1175, 175, 18, '#d9d3b6');
        disc(1240, 235, 24, '#d9d3b6');
        const roof = '#0a0812';
        for (const [x, w, h] of [[60, 170, 300], [260, 130, 220], [620, 200, 340], [860, 150, 250], [1050, 190, 320], [1290, 170, 240], [1470, 130, 290]]) {
            g.fillStyle = roof;
            g.fillRect(x, H - h, w, h);
            g.beginPath();
            g.moveTo(x - 14, H - h);
            g.lineTo(x + w / 2, H - h - 90);
            g.lineTo(x + w + 14, H - h);
            g.fill();
            for (let wy = H - h + 30; wy < H - 40; wy += 62) {
                for (let wx = x + 22; wx < x + w - 30; wx += 50) {
                    if (rnd() > 0.45) {
                        g.fillStyle = '#ffcf6b';
                        g.fillRect(wx, wy, 22, 32);
                    }
                }
            }
        }
        // The clock tower.
        g.fillStyle = roof;
        g.fillRect(430, 210, 120, 690);
        g.beginPath();
        g.moveTo(410, 210);
        g.lineTo(490, 60);
        g.lineTo(570, 210);
        g.fill();
        disc(490, 300, 44, '#ffe9a8');
        g.strokeStyle = roof;
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(490, 300);
        g.lineTo(490, 268);
        g.moveTo(490, 300);
        g.lineTo(514, 312);
        g.stroke();
    } else if (name === 'snow') {
        vertical([[0, '#f6f9fc'], [1, '#ffffff']]);
        disc(320, 170, 90, '#fffdf2');
        peaks(620, 360, 11, '#dfe7f0');
        peaks(690, 260, 15, '#eef2f7');
        ridge(720, 26, 280, '#fbfcfe');
        for (let i = 0; i < 34; i++) tree(rnd() * W, 690 + rnd() * 160, 44 + rnd() * 60, rnd() > 0.5 ? '#c9d6d2' : '#d6e0dc', '#cbbfb3');
        g.fillStyle = '#f1e3df';
        g.fillRect(1080, 650, 170, 110);
        g.fillStyle = '#e8c9c2';
        g.beginPath();
        g.moveTo(1060, 655);
        g.lineTo(1165, 570);
        g.lineTo(1270, 655);
        g.fill();
    } else if (name === 'busy') {
        g.fillStyle = '#5f6b75';
        g.fillRect(0, 0, W, H);
        const colours = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0ff', '#5856d6', '#af52de', '#ff2d55', '#ffffff', '#111111', '#a2845e'];
        for (let i = 0; i < 14000; i++) {
            g.fillStyle = colours[Math.floor(rnd() * colours.length)];
            const x = rnd() * W;
            const y = rnd() * H;
            const s = 3 + rnd() * 22;
            const kind = rnd();
            if (kind < 0.45) g.fillRect(x, y, s, s * (0.4 + rnd()));
            else if (kind < 0.8) disc(x, y, s / 2, g.fillStyle);
            else g.fillRect(x, y, s * 3, 2);
        }
    } else if (name === 'lines') {
        g.fillStyle = '#000000';
        g.fillRect(0, 0, W, H);
        g.fillStyle = '#ffffff';
        for (let y = 20; y < H; y += 60) g.fillRect(0, y, W, y < H / 2 ? 2 : 6);
        for (let x = 30; x < W; x += 90) g.fillRect(x, 0, x < W / 2 ? 1 : 3, H);
        for (let i = 0; i < 400; i++) g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 40, 2 + rnd() * 40);
    } else {
        throw new Error(`no scene called ${name}`);
    }
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
}
