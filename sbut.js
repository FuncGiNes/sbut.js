/*
 * SBUT Engine
 * Copyright (c) 2026 [FuncGines]
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

(function(global){
  var SBUT_WIDTH = 960, SBUT_HEIGHT = 540, GRAVITY = 1400;

  var listeners = { start: [], update: [], touch: [], collision: [], timer: [], jump: [], footstep: [], sceneLoad: [], keydown: [], keyup: [], objectTouch: [] };
  var messageListeners = {}; // messageName -> [fn, ...], for Game.broadcast / Input.onMessage
  var canvas, ctx, running = false, lastTime = 0, dpr = 1;
  var objects = [];      // runtime object state list
  var byName = {};       // name -> runtime object state
  var timers = [];       // {time, remaining, repeat, fn}
  var scenesMap = {};    // sceneName -> scene json def (all scenes bundled at load time)
  var currentSceneName = null;
  var keysDown = {};     // keyboard code -> boolean, kept for Input.isKeyDown()

  function emit(name, payload){
    (listeners[name] || []).forEach(function(fn){
      try { fn(payload); } catch(e){ reportError(e); }
    });
  }

  function reportError(e){
    var msg = (e && e.message) ? e.message : String(e);
    if (global.Native && Native.log) Native.log('[JS ERROR] ' + msg);
    // Locked/exported games (__sbutDevMode === false) never show the overlay to the
    // player — it would leak script contents/line numbers from a "closed" build.
    // Native.log still receives it so a developer can pull it from logcat if needed.
    if (global.__sbutDevMode !== false) showErrorOverlay(msg);
  }

  var errorBox;
  function showErrorOverlay(msg){
    if (!errorBox){
      errorBox = document.createElement('div');
      errorBox.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:40%;overflow:auto;'
        + 'background:rgba(180,0,0,0.92);color:#fff;font:12px monospace;padding:8px;z-index:9999;white-space:pre-wrap;';
      document.body.appendChild(errorBox);
    }
    var line = document.createElement('div');
    line.textContent = msg;
    errorBox.appendChild(line);
  }

  window.onerror = function(msg, src, line, col, err){
    reportError(err || (msg + ' (line ' + line + ')'));
    return true;
  };

  // ---------------- Game ----------------
  var Game = {
    width: SBUT_WIDTH,
    height: SBUT_HEIGHT,
    onStart: function(fn){ listeners.start.push(fn); },
    onUpdate: function(fn){ listeners.update.push(fn); },
    start: function(){
      setupCanvas();
      // scenesMap comes from all scenes/*.json bundled by the app at load time.
      // __sbutScene (singular) is kept as a fallback for older single-scene projects.
      scenesMap = global.__sbutScenes || (global.__sbutScene ? { main: global.__sbutScene } : {});
      var entry = global.__sbutEntryScene || Object.keys(scenesMap)[0];
      currentSceneName = entry;
      SceneRuntime.load(scenesMap[entry]);
      running = true;
      emit('start');
      emit('sceneLoad', currentSceneName);
      requestAnimationFrame(loop);
    },
    pause: function(){ running = false; },
    resume: function(){ if(!running){ running = true; lastTime = 0; requestAnimationFrame(loop); } },
    exit: function(){ running = false; if(global.Native) Native.exitGame(); },
    // ---- helpers used by generated Block-editor code (Sensing blocks) ----
    isTouching: function(nameA, nameB){
      var a = byName[nameA], b = byName[nameB];
      if (!a || !b) return false;
      var ba = aabb(a), bb = aabb(b);
      return (ba.left < bb.right && ba.right > bb.left && ba.top < bb.bottom && ba.bottom > bb.top);
    },
    isButtonDown: function(id){
      var btn = UIControls.buttons.filter(function(b){ return b.id === id; })[0];
      return !!(btn && btn.pressed);
    },
    random: function(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; },
    distance: function(nameA, nameB){
      var a = byName[nameA], b = byName[nameB];
      if (!a || !b) return 0;
      return Math.hypot(a.x - b.x, a.y - b.y);
    },
    clamp: function(value, min, max){
      value = Number(value) || 0;
      if (min > max){ var tmp = min; min = max; max = tmp; }
      return Math.min(Math.max(value, min), max);
    },
    lerp: function(a, b, t){ a = Number(a) || 0; b = Number(b) || 0; t = Number(t) || 0; return a + (b - a) * t; },
    // Fisher-Yates: shuffles the array in place and also returns it, so it drops straight into a list block.
    shuffle: function(arr){
      if (!Array.isArray(arr)) return arr;
      for (var i = arr.length - 1; i > 0; i--){
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    },
    // ---- message system (Scratch/Pocket Code "broadcast"): decouples scripts, e.g. a menu
    // script can fire "startGame" and any number of independent scripts can react to it ----
    broadcast: function(name, data){
      (messageListeners[name] || []).forEach(function(fn){
        try { fn(data); } catch(e){ reportError(e); }
      });
    }
  };

  // ---- Debug print, used by the "Debug: print" block ----
  global.log = function(msg){
    if (global.Native && Native.log) Native.log(String(msg));
    if (global.console && console.log) console.log(msg);
  };

  function setupCanvas(){
    canvas = document.getElementById('sbut-canvas');
    ctx = canvas.getContext('2d');
    dpr = global.devicePixelRatio || 1;
    canvas.width = SBUT_WIDTH * dpr;
    canvas.height = SBUT_HEIGHT * dpr;
    UIControls.init();
  }

  function loop(time){
    if(!running) return;
    var dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;

    stepTimers(dt);
    stepTransition(dt);
    applyControlInput();
    AnimRuntime.step(dt);
    PhysicsRuntime.step(dt);
    emit('update', dt);
    CameraRuntime.step(dt);
    Renderer.draw();

    requestAnimationFrame(loop);
  }

  function stepTimers(dt){
    for (var i = timers.length - 1; i >= 0; i--){
      var t = timers[i];
      t.remaining -= dt;
      if (t.remaining <= 0){
        emit('timer', { name: t.name });
        try { t.fn && t.fn(); } catch(e){ reportError(e); }
        if (t.repeat){ t.remaining += t.interval; } else { timers.splice(i, 1); }
      }
    }
  }

  // ---------------- Scene switching (with fade transition) ----------------
  var transition = { active: false, phase: '', t: 0, duration: 0.22, pendingScene: null };

  function startSceneTransition(name){
    if (!scenesMap[name]){
      if (global.Native && Native.log) Native.log('[SBUT] unknown scene: ' + name);
      return;
    }
    if (transition.active && transition.pendingScene === name) return;
    transition.active = true;
    transition.phase = 'out';
    transition.t = 0;
    transition.pendingScene = name;
  }

  function stepTransition(dt){
    if (!transition.active) return;
    transition.t += dt;
    if (transition.phase === 'out' && transition.t >= transition.duration){
      SceneRuntime.load(scenesMap[transition.pendingScene]);
      currentSceneName = transition.pendingScene;
      emit('sceneLoad', currentSceneName);
      transition.phase = 'in';
      transition.t = 0;
    } else if (transition.phase === 'in' && transition.t >= transition.duration){
      transition.active = false;
    }
  }

  function transitionAlpha(){
    if (!transition.active) return 0;
    var p = Math.min(transition.t / transition.duration, 1);
    return transition.phase === 'out' ? p : (1 - p);
  }

  var Scene = {
    load: function(name){ startSceneTransition(name); },
    onLoad: function(fn){ listeners.sceneLoad.push(fn); }
  };
  Object.defineProperty(Scene, 'current', { get: function(){ return currentSceneName; } });

  var SceneRuntime = {
    load: function(data){
      // drop previous scene's global object handles before spawning the new one
      objects.forEach(function(o){ delete global[o.name]; });
      objects = [];
      byName = {};
      if (!data || !data.objects) return;
      data.objects.forEach(function(def){ SceneRuntime.spawn(def); });
    },
    spawn: function(def){
      var t = def.transform || {};
      var state = {
        id: def.id || def.name,
        name: def.name || ('obj' + objects.length),
        type: def.type || 'Empty',
        isStatic: !!def.static,
        x: t.x || 0,
        y: t.y || 0,
        rotation: t.rotation || 0,
        scaleX: t.scaleX == null ? 1 : t.scaleX,
        scaleY: t.scaleY == null ? 1 : t.scaleY,
        sprite: def.spriteRenderer || null,
        text: def.textRenderer || null,
        collider: def.collider || null,
        rigidbody: def.rigidbody || null,
        action: def.action || null,       // e.g. { type:'loadScene', scene:'room2' } fired on trigger enter
        actionCooldown: false,
        image: null,
        imageFailed: false,
        followTarget: null,
        followSmooth: 0.1,
        grounded: false,
        walkPhase: 0,
        walkBob: 0,
        stepTimer: 0,
        // ---- costume animation (frame flip-book): opt-in via spriteRenderer.frames = [path, ...] ----
        animFrames: (def.spriteRenderer && def.spriteRenderer.frames) || null,
        animImages: null,
        animIndex: 0,
        animFps: (def.spriteRenderer && def.spriteRenderer.animFps) || 8,
        animPlaying: !!(def.spriteRenderer && def.spriteRenderer.frames && def.spriteRenderer.autoPlay !== false),
        animTimer: 0
      };
      if (state.animFrames && state.animFrames.length){
        state.animImages = state.animFrames.map(function(path){
          var img = new Image();
          img.src = 'assets/' + path;
          return img;
        });
      }
      if (state.sprite && state.sprite.assetPath){
        var img = new Image();
        img.onerror = function(){ state.imageFailed = true; };
        img.src = 'assets/' + state.sprite.assetPath;
        state.image = img;
      }
      objects.push(state);
      byName[state.name] = state;
      global[state.name] = makeObjectHandle(state);
      return state;
    },
    all: function(){ return objects; }
  };

  function makeObjectHandle(state){
    var handle = {};
    Object.defineProperties(handle, {
      x: { get: function(){ return state.x; }, set: function(v){ state.x = v; } },
      y: { get: function(){ return state.y; }, set: function(v){ state.y = v; } },
      rotation: { get: function(){ return state.rotation; }, set: function(v){ state.rotation = v; } },
      vx: { get: function(){ return state.rigidbody ? state.rigidbody.velocityX : 0; } },
      vy: { get: function(){ return state.rigidbody ? state.rigidbody.velocityY : 0; } },
      grounded: { get: function(){ return !!state.grounded; } },
      name: { get: function(){ return state.name; } }
    });
    handle.move = function(dx, dy){ state.x += (dx || 0); state.y += (dy || 0); };
    handle.setPosition = function(x, y){ state.x = x; state.y = y; };
    handle.rotate = function(deg){ state.rotation += deg; };
    handle.scale = function(sx, sy){ state.scaleX = sx; state.scaleY = (sy == null ? sx : sy); };
    handle.jump = function(force){
      if (!state.rigidbody) return;
      state.rigidbody.velocityY = -(force || 300);
      emit('jump', { name: state.name });
    };
    handle.flip = function(axis){
      if (axis === 'y') state.scaleY *= -1; else state.scaleX *= -1;
    };
    // เปลี่ยนรูปลักษณ์: สลับสี/รูปได้ทันทีระหว่างเล่น
    handle.setColor = function(hex){ if (state.sprite) state.sprite.color = hex; };
    handle.setCostume = handle.setColor;
    handle.setSprite = function(path){
      if (!state.sprite) return;
      state.sprite.assetPath = path;
      state.imageFailed = false;
      var img = new Image();
      img.onerror = function(){ state.imageFailed = true; };
      img.src = 'assets/' + path;
      state.image = img;
    };
    handle.follow = function(target, smooth){
      state.followTarget = (typeof target === 'string') ? byName[target] : (target && target.name ? byName[target.name] : null);
      state.followSmooth = smooth == null ? 0.1 : smooth;
    };
    handle.lookAt = function(xOrName, y){
      var tx, ty;
      if (typeof xOrName === 'string'){
        var t = byName[xOrName];
        if (!t) return;
        tx = t.x; ty = t.y;
      } else if (xOrName && xOrName.name){
        var t2 = byName[xOrName.name];
        if (!t2) return;
        tx = t2.x; ty = t2.y;
      } else {
        tx = xOrName; ty = y;
      }
      state.rotation = Math.atan2(ty - state.y, tx - state.x) * 180 / Math.PI;
    };
    handle.setText = function(str){ if (state.text) state.text.value = str; };
    handle.show = function(){ if (state.sprite) state.sprite.visible = true; };
    handle.hide = function(){ if (state.sprite) state.sprite.visible = false; };
    handle.setAlpha = function(a){ if (state.sprite) state.sprite.alpha = a; if (state.text) state.text.alpha = a; };
    // ---- velocity / physics helpers: no-ops on objects without a rigidbody, so blocks stay crash-safe ----
    handle.setVelocity = function(vx, vy){
      if (!state.rigidbody) return;
      if (vx != null) state.rigidbody.velocityX = vx;
      if (vy != null) state.rigidbody.velocityY = vy;
    };
    handle.stop = function(){
      if (!state.rigidbody) return;
      state.rigidbody.velocityX = 0;
      state.rigidbody.velocityY = 0;
    };
    handle.setGravityScale = function(scale){
      if (!state.rigidbody) return;
      state.rigidbody.gravityScale = scale == null ? 1 : scale;
    };
    // ---- costume/frame animation (e.g. walk cycle made of real drawn frames instead of squash-math) ----
    handle.setFrames = function(paths, fps){
      state.animFrames = paths || [];
      state.animImages = state.animFrames.map(function(path){
        var img = new Image();
        img.src = 'assets/' + path;
        return img;
      });
      state.animIndex = 0;
      state.animTimer = 0;
      if (fps != null) state.animFps = fps;
    };
    handle.playAnimation = function(fps){ if (fps != null) state.animFps = fps; state.animPlaying = true; };
    handle.stopAnimation = function(){ state.animPlaying = false; };
    handle.setCostumeIndex = function(i){
      if (!state.animImages || !state.animImages.length) return;
      var n = state.animImages.length;
      state.animIndex = ((i % n) + n) % n;
    };
    handle.nextCostume = function(){
      if (!state.animImages || !state.animImages.length) return;
      state.animIndex = (state.animIndex + 1) % state.animImages.length;
    };
    handle.destroy = function(){
      objects = objects.filter(function(o){ return o !== state; });
      delete byName[state.name];
      delete global[state.name];
    };
    return handle;
  }

  // ---------------- Costume animation (flip-book of images, independent of the walk-cycle math) ----------------
  var AnimRuntime = {
    step: function(dt){
      objects.forEach(function(o){
        if (!o.animPlaying || !o.animImages || o.animImages.length < 2) return;
        o.animTimer += dt;
        var frameTime = 1 / (o.animFps || 8);
        while (o.animTimer >= frameTime){
          o.animTimer -= frameTime;
          o.animIndex = (o.animIndex + 1) % o.animImages.length;
        }
      });
    }
  };

  // ---------------- Physics ----------------
  var PhysicsRuntime = {
    step: function(dt){
      if (dt <= 0) return;
      objects.forEach(function(o){
        if (o.isStatic || !o.rigidbody) return;
        var rb = o.rigidbody;
        rb.velocityY += GRAVITY * (rb.gravityScale == null ? 1 : rb.gravityScale) * dt;
        o.x += rb.velocityX * dt;
        o.y += rb.velocityY * dt;
        var friction = rb.friction == null ? 0.9 : rb.friction;
        rb.velocityX *= Math.pow(friction, dt * 60);
        o.grounded = false;
      });
      resolveCollisions();
      objects.forEach(function(o){
        var rb = o.rigidbody;
        if (rb){
          // walk cycle: pure math (sine squash/stretch + auto-facing) instead of sprite frames
          if (Math.abs(rb.velocityX) > 5){
            o.scaleX = rb.velocityX < 0 ? -Math.abs(o.scaleX || 1) : Math.abs(o.scaleX || 1);
            o.walkPhase += dt * 10;
            o.walkBob = Math.sin(o.walkPhase) * 0.08;
            if (o.grounded){
              o.stepTimer += dt;
              if (o.stepTimer > 0.28){ o.stepTimer = 0; emit('footstep', { name: o.name }); }
            } else {
              o.stepTimer = 0;
            }
          } else {
            o.walkPhase = 0; o.walkBob = 0; o.stepTimer = 0;
          }
        }
        if (o.followTarget){
          o.x += (o.followTarget.x - o.x) * o.followSmooth;
          o.y += (o.followTarget.y - o.y) * o.followSmooth;
        }
      });
    }
  };

  function aabb(o){
    var c = o.collider || o.sprite || { width: 32, height: 32 };
    var w = c.width || 32, h = c.height || 32;
    return { left: o.x - w/2, right: o.x + w/2, top: o.y - h/2, bottom: o.y + h/2, w: w, h: h };
  }

  function resolveCollisions(){
    for (var i = 0; i < objects.length; i++){
      var a = objects[i];
      if (!a.collider) continue;
      for (var j = i + 1; j < objects.length; j++){
        var b = objects[j];
        if (!b.collider) continue;
        var ba = aabb(a), bb = aabb(b);
        var overlapX = Math.min(ba.right, bb.right) - Math.max(ba.left, bb.left);
        var overlapY = Math.min(ba.bottom, bb.bottom) - Math.max(ba.top, bb.top);
        if (overlapX > 0 && overlapY > 0){
          var trigger = a.collider.isTrigger || b.collider.isTrigger;
          emit('collision', { a: a.name, b: b.name, trigger: !!trigger });
          if (trigger){
            [a, b].forEach(function(o){
              if (o.action && o.action.type === 'loadScene' && !o.actionCooldown){
                o.actionCooldown = true;
                startSceneTransition(o.action.scene);
              }
            });
            continue;
          }
          // resolve along smaller overlap axis; push the non-static one
          var movable = !a.isStatic ? a : (!b.isStatic ? b : null);
          if (!movable) continue;
          var other = movable === a ? b : a;
          var mAabb = movable === a ? ba : bb;
          var oAabb = movable === a ? bb : ba;
          if (overlapX < overlapY){
            var pushX = (mAabb.left < oAabb.left) ? -overlapX : overlapX;
            movable.x += pushX;
            if (movable.rigidbody) movable.rigidbody.velocityX = 0;
          } else {
            var pushY = (mAabb.top < oAabb.top) ? -overlapY : overlapY;
            movable.y += pushY;
            if (movable.rigidbody){
              if (pushY < 0) movable.grounded = true;
              movable.rigidbody.velocityY = 0;
            }
          }
        }
      }
    }
  }

  // ---------------- Camera ----------------
  var CameraRuntime = {
    shakeTime: 0, shakeIntensity: 0, offsetX: 0, offsetY: 0,
    step: function(dt){
      if (Camera._followTarget){
        var target = Camera._followTarget;
        var tx = target.x, ty = target.y;
        Camera.x += (tx - Camera.x) * 0.08;
        Camera.y += (ty - Camera.y) * 0.08;
      }
      if (this.shakeTime > 0){
        this.shakeTime -= dt;
        var s = this.shakeIntensity * (this.shakeTime > 0 ? 1 : 0);
        this.offsetX = (Math.random() * 2 - 1) * s;
        this.offsetY = (Math.random() * 2 - 1) * s;
      } else {
        this.offsetX = 0; this.offsetY = 0;
      }
    }
  };

  var Camera = {
    x: 0, y: 0, zoom: 1,
    follow: function(target){ Camera._followTarget = target; },
    shake: function(intensity, duration){
      CameraRuntime.shakeIntensity = intensity || 8;
      CameraRuntime.shakeTime = duration == null ? 0.3 : duration;
    }
  };

  // ---------------- On-screen controls: drawn with pure math (trig), no image assets ----------------
  function rotatePoint(x, y, angle){
    var c = Math.cos(angle), s = Math.sin(angle);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  var UIControls = {
    buttons: [],
    init: function(){
      var r = 42, margin = 78;
      this.buttons = [
        { id: 'left',  cx: margin,               cy: SBUT_HEIGHT - margin, r: r, pressed: false, angle: Math.PI },
        { id: 'right', cx: margin + r * 2 + 20,   cy: SBUT_HEIGHT - margin, r: r, pressed: false, angle: 0 },
        { id: 'jump',  cx: SBUT_WIDTH - margin,   cy: SBUT_HEIGHT - margin, r: r, pressed: false, angle: -Math.PI / 2 }
      ];
    },
    visible: function(){ return !!byName['player']; },
    hitTest: function(x, y){
      if (!this.visible()) return null;
      for (var i = 0; i < this.buttons.length; i++){
        var b = this.buttons[i];
        var dx = x - b.cx, dy = y - b.cy;
        if (dx * dx + dy * dy <= b.r * b.r) return b;
      }
      return null;
    },
    clearAll: function(){ this.buttons.forEach(function(b){ b.pressed = false; }); },
    draw: function(ctx){
      if (!this.visible()) return;
      this.buttons.forEach(function(b){
        ctx.save();
        ctx.beginPath();
        ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
        ctx.fillStyle = b.pressed ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.14)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.stroke();
        // arrow triangle computed purely from rotation-matrix math, not an image
        var s = b.r * 0.5;
        var p1 = rotatePoint(s, 0, b.angle);
        var p2 = rotatePoint(-s * 0.6, s * 0.7, b.angle);
        var p3 = rotatePoint(-s * 0.6, -s * 0.7, b.angle);
        ctx.beginPath();
        ctx.moveTo(b.cx + p1.x, b.cy + p1.y);
        ctx.lineTo(b.cx + p2.x, b.cy + p2.y);
        ctx.lineTo(b.cx + p3.x, b.cy + p3.y);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();
      });
    }
  };

  function applyControlInput(){
    var p = byName['player'];
    if (!p || !p.rigidbody) return;
    var speed = 220;
    var left = UIControls.buttons[0], right = UIControls.buttons[1];
    if (left.pressed && !right.pressed) p.rigidbody.velocityX = -speed;
    else if (right.pressed && !left.pressed) p.rigidbody.velocityX = speed;
  }

  // ---------------- Renderer ----------------
  var Renderer = {
    draw: function(){
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SBUT_WIDTH, SBUT_HEIGHT);
      ctx.save();
      ctx.translate(SBUT_WIDTH/2 - Camera.x * Camera.zoom + CameraRuntime.offsetX,
                     SBUT_HEIGHT/2 - Camera.y * Camera.zoom + CameraRuntime.offsetY);
      ctx.scale(Camera.zoom, Camera.zoom);

      var sorted = objects.slice().sort(function(x, y){
        var zx = (x.sprite && x.sprite.zIndex) || 0;
        var zy = (y.sprite && y.sprite.zIndex) || 0;
        return zx - zy;
      });

      sorted.forEach(function(o){ Renderer.drawObject(o); });
      ctx.restore();

      // screen-space overlay: on-screen controls, then the scene-transition fade on top
      UIControls.draw(ctx);
      var ta = transitionAlpha();
      if (ta > 0){
        ctx.fillStyle = 'rgba(0,0,0,' + ta + ')';
        ctx.fillRect(0, 0, SBUT_WIDTH, SBUT_HEIGHT);
      }
      ctx.restore();
    },
    drawObject: function(o){
      if (o.sprite && o.sprite.visible === false) return;
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate((o.rotation || 0) * Math.PI / 180);
      var bob = o.walkBob || 0;
      ctx.scale((o.scaleX || 1) * (1 - Math.abs(bob)), (o.scaleY || 1) * (1 + bob));

      if (o.type === 'Text' && o.text){
        ctx.globalAlpha = o.text.alpha == null ? 1 : o.text.alpha;
        ctx.fillStyle = o.text.color || '#ffffff';
        ctx.font = (o.text.fontSize || 24) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.text.value || '', 0, 0);
      } else if (o.sprite){
        ctx.globalAlpha = o.sprite.alpha == null ? 1 : o.sprite.alpha;
        var w = o.sprite.width || 32, h = o.sprite.height || 32;
        var frameImg = (o.animImages && o.animImages.length) ? o.animImages[o.animIndex] : null;
        if (frameImg && frameImg.complete && frameImg.naturalWidth > 0){
          ctx.drawImage(frameImg, -w/2, -h/2, w, h);
        } else if (o.image && o.image.complete && !o.imageFailed && o.image.naturalWidth > 0){
          ctx.drawImage(o.image, -w/2, -h/2, w, h);
        } else {
          ctx.fillStyle = o.sprite.color || '#8b5cf6';
          ctx.fillRect(-w/2, -h/2, w, h);
        }
      }
      ctx.restore();
    }
  };

  // ---------------- Audio ----------------
  var Audio = {
    play: function(name, opts){
      opts = opts || {};
      if(global.Native) Native.audioPlay(name, !!opts.loop, opts.volume == null ? 1.0 : opts.volume);
    },
    pause: function(name){ if(global.Native) Native.audioPause(name); },
    resume: function(name){ if(global.Native) Native.audioResume(name); },
    stopAll: function(){ if(global.Native && Native.audioStopAll) Native.audioStopAll(); }
  };

  // ---------------- Player (legacy global helper) ----------------
  var Player = {
    move: function(dx, dy){
      var p = byName['player'];
      if (p){ p.x += (dx || 0); p.y += (dy || 0); }
      emit('playerMove', { dx: dx, dy: dy || 0 });
    }
  };

  // ---------------- Input ----------------
  var Input = {
    onTouch: function(fn){ listeners.touch.push(fn); },
    onCollision: function(fn){ listeners.collision.push(fn); },
    onJump: function(fn){ listeners.jump.push(fn); },
    onFootstep: function(fn){ listeners.footstep.push(fn); },
    onKeyDown: function(fn){ listeners.keydown.push(fn); },
    onKeyUp: function(fn){ listeners.keyup.push(fn); },
    isKeyDown: function(code){ return !!keysDown[code]; },
    // fires only when the *named* object is the one tapped (filter matches the generated code's own check too)
    onObjectTouch: function(fn){ listeners.objectTouch.push(fn); },
    onMessage: function(name, fn){
      (messageListeners[name] = messageListeners[name] || []).push(fn);
    }
  };

  // keyboard is optional hardware (most devices are touch-only), so these listeners
  // are purely additive and never assumed to fire — every Input.onKeyDown block still
  // needs the object/condition checks a user writes inside it to behave safely.
  document.addEventListener('keydown', function(e){
    if (!keysDown[e.code]){
      keysDown[e.code] = true;
      emit('keydown', e.code);
    }
  });
  document.addEventListener('keyup', function(e){
    keysDown[e.code] = false;
    emit('keyup', e.code);
  });

  // ---------------- Save ----------------
  var Save = {
    write: function(key, value){ if(global.Native) Native.saveWrite(key, JSON.stringify(value)); },
    read: function(key){
      if(!global.Native) return null;
      var raw = Native.saveRead(key);
      if(!raw) return null;
      try { return JSON.parse(raw); } catch(e){ return raw; }
    },
    delete: function(key){ if(global.Native) Native.saveDelete(key); }
  };

  // ---------------- HTML ----------------
  var HTML = {
    open: function(path){ emit('htmlOpen', path); },
    close: function(){ emit('htmlClose'); }
  };

  // ---------------- Timer helper (Event: Timer) ----------------
  var Timer = {
    after: function(seconds, fn, name){ timers.push({ name: name || '', remaining: seconds, repeat: false, fn: fn }); },
    every: function(seconds, fn, name){ timers.push({ name: name || '', remaining: seconds, interval: seconds, repeat: true, fn: fn }); }
  };

  global.Game = Game;
  global.Scene = Scene;
  global.Camera = Camera;
  global.Audio = Audio;
  global.Player = Player;
  global.Input = Input;
  global.Save = Save;
  global.HTML = HTML;
  global.Timer = Timer;
  global.getObject = function(name){ return byName[name] ? makeObjectHandle(byName[name]) : null; };

  function toCanvasCoords(clientX, clientY){
    var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: SBUT_WIDTH, height: SBUT_HEIGHT };
    var scaleX = SBUT_WIDTH / rect.width, scaleY = SBUT_HEIGHT / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  // screen (canvas) space -> world space, inverse of the camera transform in Renderer.draw()
  function toWorldCoords(pt){
    var zoom = Camera.zoom || 1;
    return {
      x: (pt.x - SBUT_WIDTH / 2 - CameraRuntime.offsetX) / zoom + Camera.x,
      y: (pt.y - SBUT_HEIGHT / 2 - CameraRuntime.offsetY) / zoom + Camera.y
    };
  }

  // topmost-drawn object under a world-space point, so "on object tapped" respects layering
  function objectAtWorldPoint(wx, wy){
    for (var i = objects.length - 1; i >= 0; i--){
      var o = objects[i];
      if (o.sprite && o.sprite.visible === false) continue;
      var b = aabb(o);
      if (wx >= b.left && wx <= b.right && wy >= b.top && wy <= b.bottom) return o;
    }
    return null;
  }

  document.addEventListener('touchstart', function(e){
    var t = e.touches[0];
    var pt = toCanvasCoords(t.clientX, t.clientY);
    var btn = UIControls.hitTest(pt.x, pt.y);
    if (btn){
      btn.pressed = true;
      if (btn.id === 'jump'){
        var p = byName['player'];
        if (p && p.rigidbody && p.grounded){
          p.rigidbody.velocityY = -480;
          emit('jump', { name: 'player' });
        }
      }
      return;
    }
    var world = toWorldCoords(pt);
    var hit = objectAtWorldPoint(world.x, world.y);
    if (hit) emit('objectTouch', hit.name);
    emit('touch', { x: world.x, y: world.y, phase: 'start' });
  }, { passive: true });
  document.addEventListener('touchend', function(e){
    UIControls.clearAll();
    emit('touch', { phase: 'end' });
  }, { passive: true });

  document.addEventListener('DOMContentLoaded', function(){
    if(global.__sbutAutoStart !== false) Game.start();
  });
})(window);
