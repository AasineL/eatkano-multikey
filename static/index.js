const MODE_NORMAL = 1, MODE_ENDLESS = 2, MODE_PRACTICE = 3, MODE_STAIRCASE = 4;

(function (w) {
    'use strict';
    const defaults = {4: 'dfjk', 5: 'dfjkl', 6: 'sdfjkl'};
    const memory = {};
    function readSetting(key, fallback) {
        try { return localStorage.getItem('eatkano.' + key) ?? fallback; }
        catch (_) { return memory[key] ?? fallback; }
    }
    function store(key, value) {
        memory[key] = String(value);
        try { localStorage.setItem('eatkano.' + key, String(value)); } catch (_) { /* Session fallback. */ }
    }
    const lang = /^zh\b/i.test(navigator.language) ? 'zh' : /^ja\b/i.test(navigator.language) ? 'ja' : 'en';
    const version = document.querySelector('meta[name="game-version"]')?.content || 'local';
    const I18N = $.ajax({url: './static/i18n/' + lang + '.json?v=' + encodeURIComponent(version), dataType: 'json', async: false}).responseJSON || {};
    $('[data-i18n]').each(function () { $(this).text(I18N[this.dataset.i18n] || this.textContent); });
    $('[data-placeholder-i18n]').each(function () { $(this).attr('placeholder', I18N[this.dataset.placeholderI18n]); });
    $('html').attr('lang', I18N.lang || lang);

    let lanes = Number(readSetting('lanes', 4));
    if (![4, 5, 6].includes(lanes)) lanes = 4;
    let mode = Number(readSetting('mode', MODE_NORMAL));
    if (![MODE_NORMAL, MODE_ENDLESS, MODE_PRACTICE, MODE_STAIRCASE].includes(mode)) mode = MODE_NORMAL;
    let duration = Number(readSetting('duration', 20));
    if (!Number.isInteger(duration) || duration < 1 || duration > 3600) duration = 20;
    let soundMode = readSetting('sound', 'on');
    const keysets = {};
    function validKeys(value, count) {
        return typeof value === 'string' && value.length === count && /^[a-z0-9]+$/.test(value) && new Set(value).size === count;
    }
    for (const count of [4, 5, 6]) {
        const saved = readSetting('keys.' + count, defaults[count]).toLowerCase();
        keysets[count] = validKeys(saved, count) ? saved : defaults[count];
    }
    let body, board, panel, layers, blockSize;
    let targets = [], targetIndex = 0, score = 0;
    let playing = false, over = false, welcome = true;
    let startedAt = 0, endedAt = 0, deadline = 0, clock = null, resultTimer = null;
    let generation = 0;
    const pressed = new Set();
    const badTimers = new Map();

    function playSound(id) {
        if (soundMode === 'on' && w.createjs && createjs.Sound) createjs.Sound.play(id);
    }
    function timedMode() { return mode === MODE_NORMAL; }
    function modeText() { return I18N[{[MODE_NORMAL]: 'normal', [MODE_ENDLESS]: 'endless', [MODE_PRACTICE]: 'practice', [MODE_STAIRCASE]: 'staircase'}[mode]]; }
    // One complete sweep per group; keep its progress across recycled layers.
    let stairStep = 0, stairDirection = 1;
    function nextColumn() {
        if (mode !== MODE_STAIRCASE) return Math.floor(Math.random() * lanes);
        if (stairStep === 0) stairDirection = Math.random() < 0.5 ? 1 : -1;
        const col = stairDirection === 1 ? stairStep : lanes - 1 - stairStep;
        stairStep = (stairStep + 1) % lanes;
        return col;
    }
    function updateHints() {
        $('#mode').text(modeText());
        $('#key-hint').text(lanes + 'K · ' + keysets[lanes].toUpperCase().split('').join(' · '));
        $('#lane-select button').each(function () {
            const active = Number(this.dataset.lanes) === lanes;
            this.classList.toggle('active', active);
            this.setAttribute('aria-pressed', String(active));
        });
        const hint = document.getElementById('lane-keys');
        hint.replaceChildren();
        for (const key of keysets[lanes]) {
            const span = document.createElement('span');
            span.textContent = key.toUpperCase();
            hint.appendChild(span);
        }
    }
    function buildBoard() {
        board.replaceChildren();
        layers = [0, 1].map(index => {
            const layer = document.createElement('div');
            layer.id = 'GameLayer' + (index + 1);
            layer.className = 'GameLayer';
            for (let row = 0; row < 10; row++) {
                for (let col = 0; col < lanes; col++) {
                    const cell = document.createElement('div');
                    cell.className = 'block' + (col ? ' bl' : '');
                    layer.appendChild(cell);
                }
            }
            board.appendChild(layer);
            return layer;
        });
    }
    function layout() {
        if (!body) return;
        blockSize = body.getBoundingClientRect().width / lanes;
        body.style.height = window.innerHeight + 'px';
        for (const layer of layers) {
            Array.from(layer.children).forEach((cell, index) => {
                Object.assign(cell.style, {left: (index % lanes) * blockSize + 'px', bottom: Math.floor(index / lanes) * blockSize + 'px', width: blockSize + 'px', height: blockSize + 'px'});
            });
            layer.style.transform = 'translate3d(0,' + layer.rowOffset * blockSize + 'px,0)';
        }
    }
    function clearBad(cell) {
        clearTimeout(badTimers.get(cell));
        badTimers.delete(cell);
        cell.classList.remove('bad');
    }
    function fillLayer(layer, first) {
        // Recycling is synchronous: no stale delayed transform/display callback can affect a new round.
        for (const cell of layer.children) {
            clearBad(cell);
            cell.className = 'block' + (Array.prototype.indexOf.call(layer.children, cell) % lanes ? ' bl' : '');
        }
        for (let row = first ? 1 : 0; row < 10; row++) {
            const col = nextColumn();
            const cell = layer.children[row * lanes + col];
            cell.classList.add('t' + (Math.floor(Math.random() * 5) + 1));
            targets.push({cell, col, row, layer});
        }
    }
    function clearTimers() {
        clearInterval(clock);
        clearTimeout(resultTimer);
        clock = resultTimer = null;
        for (const timer of badTimers.values()) clearTimeout(timer);
        badTimers.clear();
    }
    function restart() {
        generation++;
        clearTimers();
        targets = [];
        targetIndex = score = 0;
        stairStep = 0;
        playing = over = false;
        startedAt = endedAt = deadline = 0;
        board.classList.remove('flash');
        $('#GameScoreLayer').hide();
        layers[0].rowOffset = 0;
        layers[1].rowOffset = -10;
        fillLayer(layers[0], true);
        fillLayer(layers[1], false);
        layout();
        updatePanel();
    }
    function elapsed() { return startedAt ? Math.max(0, ((endedAt || performance.now()) - startedAt) / 1000) : 0; }
    function cps() { const seconds = elapsed(); return seconds > 0 ? score / seconds : 0; }
    function updatePanel() {
        if (timedMode()) {
            panel.textContent = over && endedAt >= deadline && deadline ? I18N['time-up'] : 'TIME:' + (playing ? Math.max(0, Math.ceil((deadline - performance.now()) / 1000)) : duration);
        } else if (mode === MODE_ENDLESS) {
            panel.textContent = 'CPS:' + (elapsed() < 2 ? (I18N.calculating || '…') : cps().toFixed(2));
        } else panel.textContent = 'SCORE:' + score;
    }
    function tick() {
        if (!playing || over) return;
        if (timedMode() && performance.now() >= deadline) {
            finish(true);
            return;
        }
        updatePanel();
    }
    function finish(timeout) {
        if (over) return;
        over = true;
        endedAt = timeout ? deadline : performance.now();
        clearInterval(clock);
        clock = null;
        if (timeout) { board.classList.add('flash'); playSound('end'); }
        updatePanel();
        const round = generation;
        resultTimer = setTimeout(() => {
            if (round !== generation) return;
            board.classList.remove('flash');
            showScore();
        }, 800);
    }
    function showScore() {
        const rate = cps();
        const result = mode === MODE_ENDLESS ? rate : score;
        const bestKey = 'best.' + lanes + '.' + mode + '.' + duration;
        const stored = Number(readSetting(bestKey, 0));
        const best = Math.max(Number.isFinite(stored) ? stored : 0, result);
        store(bestKey, best);
        const level = rate <= 5 ? 1 : rate <= 8 ? 2 : rate <= 10 ? 3 : rate <= 15 ? 4 : 5;
        $('#GameScoreLayer-text').text(I18N['text-level-' + level]);
        $('#result-context').text(lanes + 'K · ' + modeText() + ' · ' + duration + 's');
        $('#cps').text(rate.toFixed(2));
        $('#score').text(score);
        $('#best').text(mode === MODE_ENDLESS ? best.toFixed(2) : best);
        $('#GameScoreLayer-score').toggle(mode !== MODE_ENDLESS);
        $('#GameScoreLayer').show();
        $('#replay').focus();
    }
    function hit(col) {
        if (welcome || over || col < 0 || col >= lanes) return;
        if (playing && timedMode() && performance.now() >= deadline) { finish(true); return; }
        const target = targets[targetIndex];
        if (!target) return;
        if (col !== target.col) {
            if (!playing) return;
            playSound('err');
            const wrong = target.layer.children[target.row * lanes + col];
            clearBad(wrong);
            wrong.classList.add('bad');
            if (mode === MODE_PRACTICE || mode === MODE_STAIRCASE) {
                const round = generation;
                badTimers.set(wrong, setTimeout(() => {
                    if (round === generation) clearBad(wrong);
                }, 500));
            } else finish(false);
            return;
        }
        if (!playing) {
            playing = true;
            startedAt = performance.now();
            deadline = startedAt + duration * 1000;
            clock = setInterval(tick, 50);
        }
        playSound('tap');
        target.cell.className = target.cell.className.replace(/\bt([1-5])\b/, 'tt$1');
        score++;
        targetIndex++;
        for (const layer of layers) {
            layer.rowOffset++;
            if (layer.rowOffset > 10) {
                layer.rowOffset = -9;
                fillLayer(layer, false);
            }
            layer.style.transform = 'translate3d(0,' + layer.rowOffset * blockSize + 'px,0)';
        }
        if (targetIndex >= 20) { targets.splice(0, targetIndex); targetIndex = 0; }
        updatePanel();
    }
    function pointer(e) {
        if (e.button !== undefined && e.button !== 0) return;
        const point = e.touches ? e.touches[0] : e;
        if (!point) return;
        const rect = body.getBoundingClientRect();
        const x = point.clientX - rect.left;
        const y = point.clientY - rect.top;
        // Zero is a valid coordinate; intervals are left-inclusive/right-exclusive.
        if (x < 0 || x >= rect.width || y < 0 || y >= rect.height) return;
        if (e.cancelable) e.preventDefault();
        hit(Math.floor(x / blockSize));
    }
    w.init = function () {
        body = document.getElementById('gameBody');
        board = document.getElementById('GameLayerBG');
        panel = document.getElementById('GameTimeLayer');
        buildBoard();
        for (const count of [4, 5, 6]) $('#keyboard-' + count).val(keysets[count]);
        $('#gameTime').val(duration);
        $('#title').val(readSetting('title', ''));
        if ($('#title').val()) document.title = $('#title').val();
        $('#sound').text(I18N[soundMode === 'on' ? 'sound-on' : 'sound-off']);
        if (w.createjs && createjs.Sound) {
            for (const id of ['err', 'end', 'tap']) createjs.Sound.registerSound('./static/music/' + id + '.mp3', id);
        }
        if (w.PointerEvent) board.addEventListener('pointerdown', pointer);
        else {
            board.addEventListener('touchstart', pointer, {passive: false});
            board.addEventListener('mousedown', pointer);
        }
        document.addEventListener('keydown', e => {
            if (welcome || over || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
            const key = e.key.toLowerCase();
            const col = keysets[lanes].indexOf(key);
            if (key.length !== 1 || col < 0) return;
            e.preventDefault();
            if (e.repeat || pressed.has(key)) return;
            pressed.add(key);
            hit(col);
        });
        document.addEventListener('keyup', e => pressed.delete(e.key.toLowerCase()));
        w.addEventListener('blur', () => pressed.clear());
        w.addEventListener('resize', layout);
        document.addEventListener('visibilitychange', tick);
        updateHints();
        restart();
    };
    w.changeLanes = function (count) {
        if (!welcome || ![4, 5, 6].includes(count)) return;
        lanes = count;
        store('lanes', lanes);
        clearTimers();
        buildBoard();
        updateHints();
        restart();
    };
    w.changeMode = function (value) {
        if (!welcome || ![MODE_NORMAL, MODE_ENDLESS, MODE_PRACTICE, MODE_STAIRCASE].includes(value)) return;
        mode = value;
        store('mode', mode);
        updateHints();
        restart();
    };
    w.readyBtn = function () { restart(); welcome = false; $('#welcome').hide(); };
    w.replayBtn = restart;
    w.backBtn = function () { welcome = true; restart(); $('#welcome').show(); };
    w.show_setting = function () { $('#btn_group,#desc,#lane-options').hide(); $('#setting').show(); };
    w.show_btn = function () { $('#setting').hide(); $('#btn_group,#desc,#lane-options').show(); };
    w.changeSoundMode = function () {
        soundMode = soundMode === 'on' ? 'off' : 'on';
        store('sound', soundMode);
        $('#sound').text(I18N[soundMode === 'on' ? 'sound-on' : 'sound-off']);
    };
    w.save_cookie = function () {
        const next = {};
        for (const count of [4, 5, 6]) {
            const value = $('#keyboard-' + count).val().toLowerCase();
            if (!validKeys(value, count)) {
                $('#settings-error').text((I18N['invalid-keys'] || 'Invalid keys:') + ' ' + count + 'K');
                $('#keyboard-' + count).focus();
                return false;
            }
            next[count] = value;
        }
        const time = Number($('#gameTime').val());
        if (!Number.isInteger(time) || time < 1 || time > 3600) {
            $('#settings-error').text(I18N['invalid-time']);
            $('#gameTime').focus();
            return false;
        }
        for (const count of [4, 5, 6]) { keysets[count] = next[count]; store('keys.' + count, next[count]); }
        duration = time;
        store('duration', duration);
        const title = $('#title').val().trim();
        store('title', title);
        document.title = title || I18N['eat-kano'];
        $('#settings-error').text('');
        updateHints();
        restart();
        w.show_btn();
        return true;
    };
    const beforeStyle = document.createElement('style'), afterStyle = document.createElement('style');
    document.head.append(beforeStyle, afterStyle);
    function image(inputId, style, selector) {
        const file = document.getElementById(inputId).files[0];
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => { style.textContent = selector + '{background-image:url(' + JSON.stringify(reader.result) + ');}'; };
        reader.readAsDataURL(file);
    }
    w.getClickBeforeImage = () => document.getElementById('click-before-image').click();
    w.getClickAfterImage = () => document.getElementById('click-after-image').click();
    w.saveClickBeforeImage = () => image('click-before-image', beforeStyle, '.t1,.t2,.t3,.t4,.t5');
    w.saveClickAfterImage = () => image('click-after-image', afterStyle, '.tt1,.tt2,.tt3,.tt4,.tt5');
})(window);
