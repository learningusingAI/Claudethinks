// Retro mini games on a 240×320 canvas: Ular (snake), Bata (breakout), Balok (falling blocks).
// Each game exposes reset(), update(dt, held), press(action), draw(ctx), hud(), plus score/over.
(() => {
  'use strict';

  const W = 240;
  const H = 320;
  const BEST_KEY = 'claudethinks.games.best';
  const LAST_KEY = 'claudethinks.games.last';

  const PAL = {
    bg: '#0d1117',
    grid: '#161b22',
    text: '#e6edf3',
    dim: '#7d8590',
    green: '#3fb950',
    lime: '#a5d63f',
    red: '#f85149',
    yellow: '#e3b341',
    cyan: '#39c5cf',
    blue: '#4f8ff7',
    purple: '#bc8cff',
    orange: '#f0883e',
  };

  const rand = (n) => Math.floor(Math.random() * n);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Filled cell with a lighter top-left edge and darker bottom-right edge for a bevelled look.
  function block(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(x, y, w, 2);
    ctx.fillRect(x, y, 2, h);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x, y + h - 2, w, 2);
    ctx.fillRect(x + w - 2, y, 2, h);
  }

  function text(ctx, str, x, y, size = 10, color = PAL.text, align = 'center') {
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px ui-monospace, "Courier New", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  // --- Ular (snake) --------------------------------------------------------

  const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

  const snake = {
    name: 'Ular',
    help: 'Panah atau WASD untuk arah. Makan kotak merah, jangan tabrak dinding atau badan sendiri.',
    cols: 15,
    rows: 20,
    size: 16,

    reset() {
      this.cells = [{ x: 7, y: 12 }, { x: 7, y: 13 }, { x: 7, y: 14 }];
      this.dir = DIRS.up;
      this.queue = [];
      this.acc = 0;
      this.score = 0;
      this.over = false;
      this.placeFood();
    },

    placeFood() {
      const free = [];
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          if (!this.cells.some((c) => c.x === x && c.y === y)) free.push({ x, y });
        }
      }
      this.food = free.length ? free[rand(free.length)] : null;
    },

    press(action) {
      const d = DIRS[action];
      if (!d) return;
      const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
      if ((d.x === -last.x && d.y === -last.y) || d === last) return;
      if (this.queue.length < 3) this.queue.push(d);
    },

    update(dt) {
      this.acc += dt;
      const step = Math.max(65, 150 - this.score / 10 * 4);
      while (this.acc >= step && !this.over) {
        this.acc -= step;
        this.tick();
      }
    },

    tick() {
      if (this.queue.length) this.dir = this.queue.shift();
      const head = this.cells[0];
      const next = { x: head.x + this.dir.x, y: head.y + this.dir.y };
      const eating = this.food && next.x === this.food.x && next.y === this.food.y;
      const body = eating ? this.cells : this.cells.slice(0, -1);
      if (next.x < 0 || next.y < 0 || next.x >= this.cols || next.y >= this.rows
        || body.some((c) => c.x === next.x && c.y === next.y)) {
        this.over = true;
        return;
      }
      this.cells.unshift(next);
      if (eating) {
        this.score += 10;
        this.placeFood();
        if (!this.food) this.over = true; // board full: nothing left to eat
      } else {
        this.cells.pop();
      }
    },

    draw(ctx) {
      const s = this.size;
      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = PAL.grid;
      for (let y = 0; y < this.rows; y++) {
        for (let x = (y % 2); x < this.cols; x += 2) ctx.fillRect(x * s, y * s, s, s);
      }
      if (this.food) block(ctx, this.food.x * s + 2, this.food.y * s + 2, s - 4, s - 4, PAL.red);
      this.cells.forEach((c, i) => block(ctx, c.x * s + 1, c.y * s + 1, s - 2, s - 2, i === 0 ? PAL.lime : PAL.green));
    },

    hud() {
      return `Panjang ${this.cells.length}`;
    },
  };

  // --- Bata (breakout) -----------------------------------------------------

  const breakout = {
    name: 'Bata',
    help: '←/→ atau geser jari/mouse di layar untuk papan. Spasi, ● atau ketuk layar untuk melepas bola.',
    paddleY: 300,
    paddleH: 6,
    radius: 3,
    rowColors: [PAL.red, PAL.orange, PAL.yellow, PAL.green, PAL.cyan, PAL.blue, PAL.purple, PAL.lime],

    reset() {
      this.lives = 3;
      this.level = 1;
      this.score = 0;
      this.over = false;
      this.paddle = { x: W / 2, w: 44 };
      this.target = null;
      this.buildBricks();
      this.resetBall();
    },

    buildBricks() {
      const rows = Math.min(4 + this.level, 8);
      this.bricks = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < 8; c++) {
          this.bricks.push({ x: 8 + c * 28, y: 36 + r * 13, w: 26, h: 10, row: r, alive: true });
        }
      }
    },

    resetBall() {
      this.stuck = true;
      this.speed = 150 + (this.level - 1) * 18;
      this.ball = { x: this.paddle.x, y: this.paddleY - this.radius - 1, vx: 0, vy: 0 };
    },

    launch() {
      if (!this.stuck) return;
      this.stuck = false;
      const angle = (Math.random() - 0.5) * 0.8;
      this.ball.vx = this.speed * Math.sin(angle);
      this.ball.vy = -this.speed * Math.cos(angle);
    },

    press(action) {
      if (action === 'act' || action === 'up') this.launch();
    },

    pointer(x) {
      this.target = x;
    },

    tap() {
      this.launch();
    },

    update(dt, held) {
      const s = dt / 1000;
      const p = this.paddle;
      if (held.has('left') || held.has('right')) this.target = null;
      if (held.has('left')) p.x -= 230 * s;
      if (held.has('right')) p.x += 230 * s;
      if (this.target !== null) p.x = this.target;
      p.x = clamp(p.x, p.w / 2, W - p.w / 2);

      const b = this.ball;
      const r = this.radius;
      if (this.stuck) {
        b.x = p.x;
        return;
      }

      // Sub-steps keep the ball from tunnelling through bricks at high speed.
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.vx), Math.abs(b.vy)) * s / 3));
      for (let i = 0; i < steps; i++) {
        b.x += (b.vx * s) / steps;
        b.y += (b.vy * s) / steps;

        if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx); }
        if (b.x > W - r) { b.x = W - r; b.vx = -Math.abs(b.vx); }
        if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy); }

        if (b.y - r > H) {
          this.lives -= 1;
          if (this.lives <= 0) this.over = true;
          else this.resetBall();
          return;
        }

        if (b.vy > 0 && b.y + r >= this.paddleY && b.y - r <= this.paddleY + this.paddleH
          && b.x >= p.x - p.w / 2 - r && b.x <= p.x + p.w / 2 + r) {
          // Bounce angle depends on where the ball hits the paddle.
          const rel = clamp((b.x - p.x) / (p.w / 2), -1, 1);
          const angle = rel * 1.05;
          const speed = Math.hypot(b.vx, b.vy);
          b.vx = speed * Math.sin(angle);
          b.vy = -speed * Math.cos(angle);
          b.y = this.paddleY - r;
        }

        for (const k of this.bricks) {
          if (!k.alive) continue;
          if (b.x + r < k.x || b.x - r > k.x + k.w || b.y + r < k.y || b.y - r > k.y + k.h) continue;
          const overlapX = Math.min(k.x + k.w - (b.x - r), b.x + r - k.x);
          const overlapY = Math.min(k.y + k.h - (b.y - r), b.y + r - k.y);
          if (overlapX < overlapY) b.vx = -b.vx;
          else b.vy = -b.vy;
          k.alive = false;
          this.score += 10 * (8 - k.row);
          break;
        }
      }

      if (this.bricks.every((k) => !k.alive)) {
        this.level += 1;
        this.buildBricks();
        this.resetBall();
      }
    },

    draw(ctx) {
      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, W, H);
      this.bricks.forEach((k) => {
        if (k.alive) block(ctx, k.x, k.y, k.w, k.h, this.rowColors[k.row % this.rowColors.length]);
      });
      const p = this.paddle;
      block(ctx, Math.round(p.x - p.w / 2), this.paddleY, p.w, this.paddleH, PAL.text);
      ctx.fillStyle = PAL.yellow;
      ctx.fillRect(Math.round(this.ball.x - this.radius), Math.round(this.ball.y - this.radius), this.radius * 2, this.radius * 2);
      for (let i = 0; i < this.lives; i++) {
        ctx.fillStyle = PAL.red;
        ctx.fillRect(8 + i * 10, 12, 6, 6);
      }
      text(ctx, `LV ${this.level}`, W - 8, 15, 10, PAL.dim, 'right');
    },

    hud() {
      return `Nyawa ${this.lives} · Level ${this.level}`;
    },
  };

  // --- Balok (falling blocks) ----------------------------------------------

  const PIECES = {
    I: { color: PAL.cyan, m: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]] },
    O: { color: PAL.yellow, m: [[1, 1], [1, 1]] },
    T: { color: PAL.purple, m: [[0, 1, 0], [1, 1, 1], [0, 0, 0]] },
    S: { color: PAL.green, m: [[0, 1, 1], [1, 1, 0], [0, 0, 0]] },
    Z: { color: PAL.red, m: [[1, 1, 0], [0, 1, 1], [0, 0, 0]] },
    J: { color: PAL.blue, m: [[1, 0, 0], [1, 1, 1], [0, 0, 0]] },
    L: { color: PAL.orange, m: [[0, 0, 1], [1, 1, 1], [0, 0, 0]] },
  };

  const rotateCW = (m) => m[0].map((_, i) => m.map((row) => row[i]).reverse());

  const blocks = {
    name: 'Balok',
    help: '←/→ geser, ↑ putar, ↓ turun cepat, Spasi atau ● jatuhkan langsung. Penuhi satu baris untuk menghapusnya.',
    cols: 10,
    rows: 20,
    cell: 15,
    ox: 10,
    oy: 10,

    reset() {
      this.board = Array.from({ length: this.rows }, () => Array(this.cols).fill(null));
      this.bag = [];
      this.next = this.take();
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.acc = 0;
      this.over = false;
      this.spawn();
    },

    // 7-bag randomizer: every piece appears once per bag, so droughts stay short.
    take() {
      if (!this.bag.length) {
        this.bag = Object.keys(PIECES);
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = rand(i + 1);
          [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
        }
      }
      return this.bag.pop();
    },

    spawn() {
      this.type = this.next;
      this.next = this.take();
      this.m = PIECES[this.type].m.map((row) => row.slice());
      this.x = Math.floor((this.cols - this.m[0].length) / 2);
      this.y = 0;
      if (this.collides(this.m, this.x, this.y)) this.over = true;
    },

    collides(m, px, py) {
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m[r].length; c++) {
          if (!m[r][c]) continue;
          const x = px + c;
          const y = py + r;
          if (x < 0 || x >= this.cols || y >= this.rows) return true;
          if (y >= 0 && this.board[y][x]) return true;
        }
      }
      return false;
    },

    lock() {
      const color = PIECES[this.type].color;
      this.m.forEach((row, r) => row.forEach((v, c) => {
        if (v && this.y + r >= 0) this.board[this.y + r][this.x + c] = color;
      }));
      const kept = this.board.filter((row) => row.some((v) => !v));
      const cleared = this.rows - kept.length;
      while (kept.length < this.rows) kept.unshift(Array(this.cols).fill(null));
      this.board = kept;
      if (cleared) {
        this.score += [0, 100, 300, 500, 800][cleared] * this.level;
        this.lines += cleared;
        this.level = 1 + Math.floor(this.lines / 10);
      }
      this.acc = 0;
      this.spawn();
    },

    press(action) {
      if (this.over) return;
      if (action === 'left' || action === 'right') {
        const dx = action === 'left' ? -1 : 1;
        if (!this.collides(this.m, this.x + dx, this.y)) this.x += dx;
      } else if (action === 'up') {
        const rotated = rotateCW(this.m);
        for (const kick of [0, -1, 1, -2, 2]) {
          if (!this.collides(rotated, this.x + kick, this.y)) {
            this.m = rotated;
            this.x += kick;
            break;
          }
        }
      } else if (action === 'down') {
        if (!this.collides(this.m, this.x, this.y + 1)) {
          this.y += 1;
          this.score += 1;
          this.acc = 0;
        } else {
          this.lock();
        }
      } else if (action === 'act') {
        while (!this.collides(this.m, this.x, this.y + 1)) {
          this.y += 1;
          this.score += 2;
        }
        this.lock();
      }
    },

    update(dt) {
      this.acc += dt;
      const interval = Math.max(90, 800 - (this.level - 1) * 70);
      while (this.acc >= interval && !this.over) {
        this.acc -= interval;
        if (!this.collides(this.m, this.x, this.y + 1)) this.y += 1;
        else this.lock();
      }
    },

    drawPiece(ctx, m, px, py, color, size, ghost = false) {
      m.forEach((row, r) => row.forEach((v, c) => {
        if (!v || py + r < 0) return;
        const x = this.ox + (px + c) * size;
        const y = this.oy + (py + r) * size;
        if (ghost) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.45;
          ctx.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
          ctx.globalAlpha = 1;
        } else {
          block(ctx, x, y, size - 1, size - 1, color);
        }
      }));
    },

    draw(ctx) {
      const s = this.cell;
      const bw = this.cols * s;
      const bh = this.rows * s;
      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = PAL.grid;
      ctx.fillRect(this.ox, this.oy, bw, bh);
      ctx.strokeStyle = PAL.dim;
      ctx.strokeRect(this.ox - 0.5, this.oy - 0.5, bw + 1, bh + 1);

      this.board.forEach((row, r) => row.forEach((color, c) => {
        if (color) block(ctx, this.ox + c * s, this.oy + r * s, s - 1, s - 1, color);
      }));

      if (!this.over) {
        let gy = this.y;
        while (!this.collides(this.m, this.x, gy + 1)) gy += 1;
        const color = PIECES[this.type].color;
        this.drawPiece(ctx, this.m, this.x, gy, color, s, true);
        this.drawPiece(ctx, this.m, this.x, this.y, color, s);
      }

      const px = this.ox + bw + 10;
      text(ctx, 'BERIKUT', px, 20, 9, PAL.dim, 'left');
      const next = PIECES[this.next];
      next.m.forEach((row, r) => row.forEach((v, c) => {
        if (v) block(ctx, px + c * 11, 34 + r * 11, 10, 10, next.color);
      }));
      text(ctx, 'LEVEL', px, 100, 9, PAL.dim, 'left');
      text(ctx, String(this.level), px, 116, 14, PAL.text, 'left');
      text(ctx, 'BARIS', px, 146, 9, PAL.dim, 'left');
      text(ctx, String(this.lines), px, 162, 14, PAL.text, 'left');
    },

    hud() {
      return `Level ${this.level} · Baris ${this.lines}`;
    },
  };

  // --- Shell: loop, input, HUD, high scores --------------------------------

  const GAMES = { snake, breakout, blocks };
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const hudScore = document.getElementById('hud-score');
  const hudBest = document.getElementById('hud-best');
  const hudExtra = document.getElementById('hud-extra');
  const help = document.getElementById('help');
  const btnStart = document.getElementById('btn-start');
  const pickers = document.querySelectorAll('[data-game]');

  const held = new Set();
  let best = loadBest();
  let current = 'snake';
  let game = GAMES[current];
  let state = 'ready'; // ready | playing | paused | over
  let lastTime = 0;

  function loadBest() {
    try {
      const parsed = JSON.parse(localStorage.getItem(BEST_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveBest() {
    if (game.score <= (best[current] || 0)) return false;
    best[current] = game.score;
    try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* storage unavailable */ }
    return true;
  }

  function setState(next) {
    state = next;
    btnStart.textContent = state === 'playing' ? 'Jeda' : state === 'paused' ? 'Lanjut' : 'Mulai';
  }

  function select(name) {
    if (!GAMES[name]) name = 'snake';
    current = name;
    game = GAMES[name];
    game.reset();
    held.clear();
    setState('ready');
    help.textContent = game.help;
    pickers.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.game === name)));
    try { localStorage.setItem(LAST_KEY, name); } catch { /* storage unavailable */ }
  }

  function startOrToggle() {
    if (state === 'ready' || state === 'over') {
      if (state === 'over') game.reset();
      setState('playing');
    } else if (state === 'playing') {
      setState('paused');
    } else {
      setState('playing');
    }
    lastTime = performance.now();
  }

  function restart() {
    game.reset();
    held.clear();
    setState('playing');
    lastTime = performance.now();
  }

  let newBest = false;

  function drawOverlay() {
    if (state === 'playing') return;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);
    if (state === 'ready') {
      text(ctx, game.name.toUpperCase(), W / 2, H / 2 - 24, 22, PAL.lime);
      text(ctx, 'TEKAN MULAI', W / 2, H / 2 + 8, 11);
      text(ctx, 'ATAU ENTER', W / 2, H / 2 + 24, 9, PAL.dim);
    } else if (state === 'paused') {
      text(ctx, 'JEDA', W / 2, H / 2, 22, PAL.yellow);
    } else {
      text(ctx, 'GAME OVER', W / 2, H / 2 - 24, 20, PAL.red);
      text(ctx, `SKOR ${game.score}`, W / 2, H / 2 + 6, 12);
      if (newBest) text(ctx, 'REKOR BARU!', W / 2, H / 2 + 26, 11, PAL.yellow);
    }
  }

  // Only touch the DOM when a value actually changes; frame() runs ~60 times a second.
  function setText(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }

  function frame(now) {
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    if (state === 'playing') {
      game.update(dt, held);
      if (game.over) {
        newBest = saveBest();
        setState('over');
      }
    }
    game.draw(ctx);
    drawOverlay();
    setText(hudScore, String(game.score));
    setText(hudBest, String(Math.max(best[current] || 0, game.score)));
    setText(hudExtra, game.hud());
    requestAnimationFrame(frame);
  }

  function act(action) {
    if (state === 'playing') game.press(action);
    else if (action === 'act' && state !== 'paused') startOrToggle();
  }

  // Keyboard
  const KEYS = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'act',
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.code === 'Enter') {
      if (e.target.closest && e.target.closest('button, a')) return; // let Enter activate focused controls
      e.preventDefault();
      startOrToggle();
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (state === 'playing' || state === 'paused') startOrToggle();
      return;
    }
    const action = KEYS[e.code];
    if (!action) return;
    e.preventDefault(); // keep arrows and space from scrolling the page
    held.add(action);
    if (e.repeat && (action === 'up' || action === 'act')) return;
    act(action);
  });

  document.addEventListener('keyup', (e) => {
    const action = KEYS[e.code];
    if (action) held.delete(action);
  });

  // Touch pad: press once, then auto-repeat while held.
  document.querySelectorAll('.pad [data-act]').forEach((button) => {
    const action = button.dataset.act;
    let delay = null;
    let repeat = null;
    const stop = () => {
      clearTimeout(delay);
      clearInterval(repeat);
      held.delete(action);
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      held.add(action);
      act(action);
      if (action === 'left' || action === 'right' || action === 'down') {
        delay = setTimeout(() => { repeat = setInterval(() => act(action), 70); }, 180);
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => button.addEventListener(type, stop));
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // Canvas: tap to start or launch; pointer position steers the paddle.
  function canvasX(e) {
    const rect = canvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'ready' || state === 'over') startOrToggle();
    else if (state === 'playing') {
      if (game.pointer) game.pointer(canvasX(e));
      if (game.tap) game.tap();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (state === 'playing' && game.pointer && (e.pointerType === 'mouse' || e.buttons)) game.pointer(canvasX(e));
  });

  // After a click, hand keyboard focus to the screen so Enter/Space drive the game
  // instead of re-activating the button that was just clicked.
  const focusScreen = () => canvas.focus({ preventScroll: true });

  btnStart.addEventListener('click', () => { startOrToggle(); focusScreen(); });
  document.getElementById('btn-restart').addEventListener('click', () => { restart(); focusScreen(); });
  pickers.forEach((b) => b.addEventListener('click', () => { select(b.dataset.game); focusScreen(); }));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'playing') setState('paused');
  });
  window.addEventListener('blur', () => held.clear());

  let initial = 'snake';
  try { initial = localStorage.getItem(LAST_KEY) || 'snake'; } catch { /* storage unavailable */ }
  select(initial);
  requestAnimationFrame((t) => { lastTime = t; frame(t); });
})();
