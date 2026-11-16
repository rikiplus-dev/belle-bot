/* בלבוט: לוח הבקרה. נפתח מתוך טלגרם, וכל בקשה חתומה על ידי טלגרם. */
(function () {
  'use strict';

  var tgApp = window.Telegram && window.Telegram.WebApp;
  var initData = (tgApp && tgApp.initData) || '';
  if (tgApp) {
    try {
      tgApp.ready();
      tgApp.expand();
      if (tgApp.colorScheme) document.documentElement.setAttribute('data-theme', tgApp.colorScheme);
    } catch (e) {}
  }

  var ICON = {
    pee: '<svg viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><path d="M24 5c7 8.500 12 14.500 12 21.500a12 12 0 0 1-24 0C12 19.500 17 13.500 24 5z"/></svg>',
    poop: '<svg viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><path d="M12 41c-3.500 0-6-2-6-4.700s2.500-4.700 6-4.700h24c3.500 0 6 2 6 4.700S39.500 41 36 41z"/><path d="M15 32c-3 0-5-1.800-5-4s2-4 5-4h18c3 0 5 1.800 5 4s-2 4-5 4z"/><path d="M19 24.500c-2.500 0-4-1.400-4-3.200s1.500-3.300 4-3.300c0-3 2-6 5-7.500 0 2.500 1 4 3 5 2.500 1 3.500 2.800 3.500 4.800s-1.500 4.200-4 4.200z"/></svg>',
    meal: '<svg viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><path d="M7 25h34c0 9-7 16-17 16S7 34 7 25z"/><circle cx="17" cy="18" r="3.300"/><circle cx="25" cy="14.500" r="3.300"/><circle cx="32" cy="19" r="3.300"/></svg>',
    walk: '<svg viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><ellipse cx="24" cy="32" rx="10" ry="8"/><circle cx="11" cy="22" r="4.200"/><circle cx="19.500" cy="13.500" r="4.600"/><circle cx="28.500" cy="13.500" r="4.600"/><circle cx="37" cy="22" r="4.200"/></svg>',
    cook: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 22h28v12a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6z" fill="currentColor"/><path d="M6 26h4M38 26h4M20 18h8" stroke="currentColor" stroke-width="2.800" stroke-linecap="round" fill="none"/><path d="M19 13c-2.500-3 2.500-4 0-8M27 13c-2.500-3 2.500-4 0-8" stroke="currentColor" stroke-width="2.500" stroke-linecap="round" fill="none"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.500l2.900 6 6.600.9-4.800 4.600 1.200 6.500L12 17.300 6.100 20.500l1.200-6.500L2.500 9.400l6.600-.9z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.500"/><path d="M7.500 12.300l3 3 6-6.300"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18.200v.1"/></svg>'
  };
  var KIND_UI = {
    pee_out: { icon: 'pee', c: '--good', short: 'פיפי' },
    poop_out: { icon: 'poop', c: '--good', short: 'קקי' },
    pee_home: { icon: 'pee', c: '--home', short: 'פיפי' },
    poop_home: { icon: 'poop', c: '--home', short: 'קקי' },
    meal: { icon: 'meal', c: '--meal', short: 'אכלה' },
    cook: { icon: 'cook', c: '--cook', short: 'הכנת אוכל' }
  };
  var MEMBER_COLOR = { amti: '--walk', riki: '--cook', shuli: '--good', sharoli: '--meal', beri: '--home' };
  var PHOTOS = [1, 2, 3, 4, 5].map(function (n) { return '/assets/bell-photo-' + n + '.jpg'; });

  var S = null;
  var fetchedAt = 0;
  var pendingDelete = null;
  var pdTimer = null;
  var toastTimer = null;
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name, cls) {
    var s = el('span', cls || '');
    s.innerHTML = ICON[name];
    s.style.display = 'inline-flex';
    return s;
  }
  function memberName(id) {
    var m = (S && S.members || []).filter(function (x) { return x.id === id; })[0];
    return m ? m.name : 'מישהו/י';
  }
  function nowEst() { return S.now + (Date.now() - fetchedAt); }

  /* ---------- זמן ---------- */
  function hhmm(ts) {
    return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: S.tz });
  }
  function dayKey(ts) {
    return new Date(ts).toLocaleDateString('en-CA', { timeZone: S.tz });
  }
  function dayLabel(ts) {
    var n = nowEst();
    if (dayKey(ts) === dayKey(n)) return 'היום';
    if (dayKey(ts) === dayKey(n - 86400000)) return 'אתמול';
    return new Date(ts).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: S.tz });
  }
  function dur(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'פחות מדקה';
    if (m < 60) return m + ' דק׳';
    var h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return h === 1 && r < 5 ? 'שעה' : (r >= 5 ? h + ' שע׳ ו-' + r + ' דק׳' : h + ' שע׳');
    var d = Math.floor(h / 24);
    return d === 1 ? 'יום' : d + ' ימים';
  }
  function ago(ts) {
    return Math.floor((nowEst() - ts) / 60000) < 1 ? 'הרגע' : 'לפני ' + dur(nowEst() - ts);
  }

  /* ---------- רשת ---------- */
  function call(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { authorization: 'tma ' + initData, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; });
    });
  }

  function showNote(title, text) {
    var n = $('note');
    n.className = 'note big';
    n.replaceChildren(el('b', '', title), el('span', '', text));
    n.hidden = false;
    $('content').hidden = true;
  }

  function load() {
    return call('GET', '/api/state').then(function (r) {
      if (r.status === 401) {
        showNote('לוח הבקרה נפתח מתוך הבוט', 'פתחו את בלבוט בטלגרם ולחצו על "📊 לוח בקרה".');
        return;
      }
      if (r.status === 403) {
        showNote('עוד לא נרשמתם', 'שלחו /start לבוט, הזינו את קוד המשפחה ובחרו מי אתם.');
        return;
      }
      if (!r.json || !r.json.members) {
        showNote('משהו השתבש', 'נסו לסגור ולפתוח שוב.');
        return;
      }
      S = r.json;
      fetchedAt = Date.now();
      $('note').hidden = true;
      $('content').hidden = false;
      render();
    }).catch(function () {
      if (!S) showNote('אין חיבור', 'בדקו את האינטרנט ונסו שוב.');
    });
  }

  function doAct(path, body, tile) {
    if (busy) return;
    busy = true;
    if (tile) {
      tile.classList.remove('pulse');
      void tile.offsetWidth;
      tile.classList.add('pulse');
    }
    call('POST', path, body).then(function (r) {
      if (r.json && r.json.state) {
        S = r.json.state;
        fetchedAt = Date.now();
        render();
      }
      toast((r.json && r.json.toast) || (r.status >= 400 ? 'לא הצלחנו. נסו שוב.' : ''));
    }).catch(function () { toast('אין חיבור. נסו שוב.'); }).then(function () { busy = false; });
  }

  function toast(msg) {
    if (!msg) return;
    $('toastMsg').textContent = msg;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').hidden = true; }, 2600);
  }

  /* ---------- רינדור ---------- */
  function lastOf(kind) {
    var best = 0;
    S.feed.forEach(function (f) {
      if (f.type === 'event' && f.kind === kind && f.ts > best) best = f.ts;
      if (f.type === 'walk') f.events.forEach(function (e) { if (e.kind === kind && e.ts > best) best = e.ts; });
    });
    return best;
  }

  function tile(kind, label, iconName, color, extra) {
    var b = el('button', 'tile' + (extra && extra.cls ? ' ' + extra.cls : ''));
    b.type = 'button';
    b.style.setProperty('--c', 'var(' + color + ')');
    b.dataset.act = extra && extra.act ? extra.act : 'log';
    if (kind) b.dataset.kind = kind;
    var d = el('span', 'disc');
    d.innerHTML = ICON[iconName];
    var t = el('span', '');
    t.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:1px';
    t.appendChild(el('span', 'lbl', label));
    if (kind) {
      var ts = lastOf(kind);
      t.appendChild(el('span', 'last', ts ? ago(ts) : 'טרם תועד'));
    }
    b.append(d, t);
    return b;
  }

  function render() {
    $('date').textContent = new Date(nowEst()).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: S.tz });
    var me = $('me');
    me.textContent = 'מתעד/ת בתור ' + S.me.name;
    me.hidden = false;

    // טיול
    var wc = $('walkCard');
    wc.replaceChildren();
    var w = S.active_walk;
    if (w) {
      var ban = el('div', 'walkbanner');
      var d = el('span', 'disc');
      d.innerHTML = ICON.walk;
      var txt = el('div', '');
      txt.append(el('b', '', 'בטיול עכשיו · ' + memberName(w.member)),
        el('span', '', dur(nowEst() - w.started_at) + ' · פיפי ' + w.pee_out + ' · קקי ' + w.poop_out));
      ban.append(d, txt);
      var grid = el('div', 'tiles two');
      grid.append(tile('pee_out', 'פיפי בחוץ', 'pee', '--good'), tile('poop_out', 'קקי בחוץ', 'poop', '--good'));
      var end = el('button', 'endbtn', 'חזרנו הביתה');
      end.type = 'button';
      end.dataset.act = 'walk_end';
      wc.append(ban, grid, end);
    } else {
      var g2 = el('div', 'tiles two');
      g2.appendChild(tile(null, 'יוצאים לטיול', 'walk', '--good', { act: 'walk_start', cls: 'start' }));
      wc.appendChild(g2);
    }

    var home = $('homeTiles');
    home.replaceChildren(tile('pee_home', 'פיפי בבית', 'pee', '--home'), tile('poop_home', 'קקי בבית', 'poop', '--home'));
    var care = $('careTiles');
    care.replaceChildren(tile('meal', 'בל אכלה', 'meal', '--meal'), tile('cook', 'הכנתי אוכל', 'cook', '--cook'));

    // אילוף היום
    var t = S.today;
    $('n-out').textContent = t.out;
    $('n-home').textContent = t.home;
    var tot = t.out + t.home;
    $('bar-o').style.width = tot ? (t.out / tot * 100) + '%' : '0';
    $('bar-h').style.width = tot ? (t.home / tot * 100) + '%' : '0';
    $('pct').textContent = tot ? Math.round(t.out / tot * 100) + '% מהצרכים של היום היו בחוץ' : 'עוד לא תועדו צרכים היום';
    var st = $('streak');
    st.className = 'streak' + (S.last_home ? ' warn' : '');
    st.replaceChildren(icon(S.last_home ? 'warn' : 'ok'), el('span', '', S.last_home ? 'תאונה אחרונה בבית: ' + ago(S.last_home) : 'עדיין אין תאונות בבית'));

    renderChart();
    renderBoard();
    renderFeed();
  }

  function renderChart() {
    var NS = 'http://www.w3.org/2000/svg';
    var W = 300, H = 140, base = 112, top = 22, slot = W / 7;
    var max = Math.max(3, Math.max.apply(null, S.days.map(function (d) { return d.out + d.home; })));
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'פיפי וקקי בחוץ ובבית, שבעה ימים אחרונים');
    svg.style.width = '100%';
    svg.style.height = 'auto';
    function mk(tag, attrs, text) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text != null) n.textContent = text;
      svg.appendChild(n);
      return n;
    }
    mk('line', { x1: 0, x2: W, y1: base, y2: base, stroke: 'var(--line)', 'stroke-width': 1 });
    S.days.forEach(function (d, i) {
      var cx = W - (i + 0.5) * slot; // הימים הישנים מימין
      var bw = 26, scale = (base - top) / max;
      var hOut = d.out * scale, hHome = d.home * scale;
      if (hOut) mk('rect', { x: cx - bw / 2, y: base - hOut, width: bw, height: hOut, rx: 4, fill: 'var(--good)' });
      if (hHome) mk('rect', { x: cx - bw / 2, y: base - hOut - hHome, width: bw, height: hHome, rx: 4, fill: 'var(--home)' });
      var total = d.out + d.home;
      if (total) mk('text', { x: cx, y: base - hOut - hHome - 5, 'text-anchor': 'middle', class: 'v' }, String(total));
      var lb = mk('text', { x: cx, y: base + 16, 'text-anchor': 'middle' }, d.label);
      if (d.today) lb.setAttribute('class', 'v');
    });
    var legend = el('div', 'legend');
    var a = el('span', ''); var ai = el('i'); ai.style.background = 'var(--good)'; a.append(ai, document.createTextNode('בחוץ'));
    var b = el('span', ''); var bi = el('i'); bi.style.background = 'var(--home)'; b.append(bi, document.createTextNode('בבית'));
    legend.append(a, b);
    $('chart').replaceChildren(svg, legend);
  }

  function renderBoard() {
    var box = $('board');
    var members = S.members.slice().sort(function (a, b) { return S.stars_week[b.id].total - S.stars_week[a.id].total; });
    var max = Math.max.apply(null, members.map(function (m) { return S.stars_week[m.id].total; }));
    if (!max) {
      var m0 = el('div', 'mascotbox');
      var im = el('img', 'mascot'); im.src = '/assets/bell-mascot-happy.svg'; im.alt = '';
      m0.append(im, el('div', '', 'בל מחכה לכוכבים הראשונים. טיול, פיפי בחוץ והכנת אוכל נותנים כוכב.'));
      box.replaceChildren(m0);
      return;
    }
    var wrap = el('div', 'rows-wrap');
    members.forEach(function (m) {
      var r = el('div', 'brow');
      r.style.setProperty('--c', 'var(' + (MEMBER_COLOR[m.id] || '--walk') + ')');
      var dot = el('span', 'dot', m.name.charAt(0));
      var mid = el('div', 'mid');
      var tr = el('div', 'track'); var fill = el('i'); fill.style.width = (S.stars_week[m.id].total / max * 100) + '%'; tr.appendChild(fill);
      mid.append(el('span', '', m.name), tr);
      var cnt = el('span', 'cnt');
      cnt.append(icon('star'), document.createTextNode(String(S.stars_week[m.id].total)));
      r.append(dot, mid, cnt);
      wrap.appendChild(r);
    });
    box.replaceChildren(wrap);
  }

  function starBadge(n) {
    var s = el('span', 'sb');
    s.append(icon('star'), document.createTextNode('+' + n));
    return s;
  }

  function delButton(type, id) {
    var key = type + ':' + id;
    var b = el('button', 'del' + (pendingDelete === key ? ' sure' : ''), pendingDelete === key ? 'למחוק?' : 'מחיקה');
    b.type = 'button';
    b.dataset.act = 'delete';
    b.dataset.type = type;
    b.dataset.id = id;
    return b;
  }

  function renderFeed() {
    var box = $('feed');
    if (!S.feed.length) {
      var e = el('div', 'empty');
      var im = el('img', 'mascot'); im.src = '/assets/bell-mascot-sleepy.svg'; im.alt = '';
      e.append(im, el('b', '', 'בל מחכה לתיעוד הראשון'), el('span', '', 'התחילו טיול או תעדו פעולה, והיא תופיע כאן.'));
      box.replaceChildren(e);
      return;
    }
    var frag = document.createDocumentFragment();
    var cur = null, rows = null;
    S.feed.forEach(function (f) {
      var k = dayKey(f.ts);
      if (k !== cur) {
        cur = k;
        var day = el('div', 'day');
        day.appendChild(el('h3', '', dayLabel(f.ts)));
        rows = el('div', 'rows');
        day.appendChild(rows);
        frag.appendChild(day);
      }
      var row = el('div', 'row');
      var main = el('div', 'main');
      var disc = el('span', 'disc');
      if (f.type === 'walk') {
        row.style.setProperty('--c', 'var(--walk)');
        disc.innerHTML = ICON.walk;
        main.appendChild(el('b', '', 'טיול · ' + memberName(f.member)));
        var when = f.ended_at ? hhmm(f.ts) + '–' + hhmm(f.ended_at) + ' · ' + dur(f.ended_at - f.ts) : hhmm(f.ts) + ' · בטיול עכשיו';
        main.appendChild(el('span', 'sub', when + (f.auto ? ' · נסגר אוטומטית' : '')));
        if (f.events.length) {
          var inner = el('div', 'inner');
          f.events.forEach(function (ev) {
            var ui = KIND_UI[ev.kind];
            var chip = el('span', 'chip');
            chip.style.setProperty('--c', 'var(' + ui.c + ')');
            chip.append(icon(ui.icon), document.createTextNode(ui.short + ' ' + hhmm(ev.ts) + (ev.member !== f.member ? ' · ' + memberName(ev.member) : '')));
            inner.appendChild(chip);
          });
          main.appendChild(inner);
        }
        row.append(disc, main);
        if (f.ended_at) row.appendChild(starBadge(1));
        if (f.member === S.me.member) row.appendChild(delButton('walk', f.id));
      } else {
        var ui2 = KIND_UI[f.kind];
        if (!ui2) return;
        row.style.setProperty('--c', 'var(' + ui2.c + ')');
        disc.innerHTML = ICON[ui2.icon];
        main.appendChild(el('b', '', S.kinds[f.kind].label));
        main.appendChild(el('span', 'sub', hhmm(f.ts) + ' · ' + memberName(f.member)));
        row.append(disc, main);
        if (S.kinds[f.kind].star) row.appendChild(starBadge(S.kinds[f.kind].star));
        if (f.member === S.me.member) row.appendChild(delButton('event', f.id));
      }
      rows.appendChild(row);
    });
    box.replaceChildren(frag);
  }

  /* ---------- אירועים ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.dataset.act;
    if (act === 'walk_start') doAct('/api/walk/start', null, t);
    else if (act === 'walk_end') doAct('/api/walk/end', null, t);
    else if (act === 'log') doAct('/api/log', { kind: t.dataset.kind }, t);
    else if (act === 'delete') {
      var key = t.dataset.type + ':' + t.dataset.id;
      if (pendingDelete !== key) {
        pendingDelete = key;
        clearTimeout(pdTimer);
        pdTimer = setTimeout(function () { pendingDelete = null; if (S) renderFeed(); }, 3000);
        renderFeed();
      } else {
        pendingDelete = null;
        doAct('/api/delete', { type: t.dataset.type, id: Number(t.dataset.id) });
      }
    }
  });

  var pi = 0;
  $('avatar').addEventListener('click', function () {
    pi = (pi + 1) % PHOTOS.length;
    $('avatarImg').src = PHOTOS[pi];
  });

  if (!initData) {
    showNote('לוח הבקרה נפתח מתוך הבוט', 'פתחו את בלבוט בטלגרם ולחצו על "📊 לוח בקרה".');
  } else {
    load();
    setInterval(function () { if (!document.hidden && !busy) load(); }, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }
})();
