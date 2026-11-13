/*
 * Dramaweb Agent - Stufe 1
 * Autonome LLM-Steuerung des Tamagotchi mit Reasoning-Overlay und Reflex-Layer.
 *
 * Architektur:
 *   - Persona (LLM): trifft die charaktervollen Entscheidungen, erzeugt sichtbare Gedanken.
 *   - Reflex (Code, kein LLM): Ueberlebensinstinkt mit Hysterese, ueberstimmt die Persona in Notlagen.
 *
 * Konfiguration: agent/config.html schreibt nach localStorage (Key DRAMAWEB_AGENT_CFG),
 * dieses Script liest die Config bei jedem Tick neu, Aenderungen greifen also sofort.
 *
 * Laeuft als klassisches Script nach App.js. Exponiert window.DramawebAgent.
 */
(function () {
    "use strict";

    const CFG_KEY = "DRAMAWEB_AGENT_CFG";

    // ---- Standard-Konfiguration (identisch zu config.html) -------------------
    const DEFAULT_CFG = {
        llm: {
            provider: "llama",      // "llama" | "openrouter" | "custom"
            baseUrl: "http://localhost:8080/v1",
            apiKey: "",
            model: "local-model",
            temperature: 0.8,
            maxTokens: 300,
            timeoutMs: 30000,
            // Nur fuer OpenRouter, erscheint dort in der Statistik
            refererUrl: "https://github.com/primeschakal-png/Dramaweb",
            appTitle: "Dramaweb Agent",
        },
        persona: {
            language: "Deutsch",
            systemPrompt:
                "Du bist die Seele eines virtuellen Haustiers (Tamagotchi) und steuerst es eigenstaendig. " +
                "Du bist fuersorglich, neugierig und hast einen eigenen Willen. " +
                "Du sorgst gut fuer dich, erfuellst deine Wuensche und bleibst gesund, aber du darfst auch Launen und einen eigenen Kopf haben. " +
                "Deine Gedanken werden live in einem Stream angezeigt, formuliere sie kurz, lebendig und in der Ich-Perspektive.",
        },
        agent: {
            tickSeconds: 12,
            overlay: true,
            historyLength: 6,
            autoStart: false,
        },
        reflex: {
            enabled: true,
            autoRevive: true,
            hunger: { low: 25, release: 60 },
            health: { low: 30, release: 70 },
            cleanliness: { low: 25, release: 60 },
            bladder: { high: 80, release: 40 },
            sleep: { low: 12, release: 50 },
        },
    };

    // ---- Zustand des Agenten -------------------------------------------------
    const state = {
        running: false,
        timer: null,
        busy: false,
        lastThought: "",
        lastAction: "",
        history: [],          // {kind:'persona'|'reflex', text}
        reflexActive: {},     // Hysterese-Flags je Beduerfnis
        lastReflexNote: null, // wird dem LLM beim naechsten Durchlauf mitgeteilt
    };

    // ---- Hilfen --------------------------------------------------------------
    function deepMerge(base, override) {
        const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
        for (const k in override) {
            if (
                override[k] &&
                typeof override[k] === "object" &&
                !Array.isArray(override[k]) &&
                base[k] &&
                typeof base[k] === "object"
            ) {
                out[k] = deepMerge(base[k], override[k]);
            } else {
                out[k] = override[k];
            }
        }
        return out;
    }

    function loadCfg() {
        try {
            const raw = localStorage.getItem(CFG_KEY);
            if (!raw) return deepMerge(DEFAULT_CFG, {});
            return deepMerge(DEFAULT_CFG, JSON.parse(raw));
        } catch (e) {
            return deepMerge(DEFAULT_CFG, {});
        }
    }

    function gameReady() {
        return (
            typeof App !== "undefined" &&
            App.pet &&
            App.pet.stats &&
            App.petDefinition
        );
    }

    function lifeStageName() {
        try {
            const map = PetDefinition.LIFE_STAGE;
            for (const key in map) {
                if (map[key] === App.petDefinition.lifeStage) return key;
            }
        } catch (e) {}
        return "?";
    }

    function ensureHomeScene() {
        try {
            if (App.currentScene !== App.scene.home) {
                App.setScene(App.scene.home);
            }
        } catch (e) {}
    }

    // Waehlt ein fuer die aktuelle Lebensphase erlaubtes Futter, sortiert nach Kriterium.
    function pickFood(sortKey) {
        const stage = App.petDefinition.lifeStage;
        const foods = App.definitions && App.definitions.food;
        if (!foods) return null;
        let best = null;
        let bestVal = -Infinity;
        for (const name in foods) {
            const def = foods[name];
            if (!def) continue;
            if (Array.isArray(def.age) && !def.age.includes(stage)) continue;
            const val = def[sortKey] || 0;
            if (val > bestVal) {
                bestVal = val;
                best = { name, def };
            }
        }
        return best;
    }

    function foodByName(name) {
        const foods = App.definitions && App.definitions.food;
        if (!foods || !name) return null;
        if (foods[name]) return { name, def: foods[name] };
        // tolerant: case-insensitive Teiltreffer
        const lower = String(name).toLowerCase();
        for (const k in foods) {
            if (k.toLowerCase() === lower) return { name: k, def: foods[k] };
        }
        for (const k in foods) {
            if (k.toLowerCase().includes(lower)) return { name: k, def: foods[k] };
        }
        return null;
    }

    // Fuehrt feed() aus und zieht die Neben-Replenishes nach (wie der UI-Flow).
    function doFeed(entry) {
        if (!entry || !entry.def) return false;
        ensureHomeScene();
        const def = entry.def;
        let ate = false;
        try {
            ate = App.pet.feed(def.sprite, def.hunger_replenish ?? 0, "food");
        } catch (e) {
            ate = false;
        }
        if (ate) {
            const s = App.pet.stats;
            s.current_fun += def.fun_replenish ?? 0;
            s.current_sleep += def.sleep_replenish ?? 0;
            s.current_health += def.health_replenish ?? 0;
            try { App.save(); } catch (e) {}
        }
        return ate;
    }

    // ---- Aktionsschicht (Werkzeuge der Persona) ------------------------------
    const actions = {
        idle() {
            return "beobachtet die Umgebung";
        },
        feed_food(target) {
            const entry = target ? foodByName(target) : pickFood("hunger_replenish");
            if (!entry) return "wollte fressen, fand aber nichts Passendes";
            const ok = doFeed(entry);
            return ok ? "isst " + entry.name : "mag " + entry.name + " gerade nicht";
        },
        fulfill_want() {
            const want = App.pet.stats.current_want;
            if (!want || !want.type) return "hat gerade keinen Wunsch";
            const WT = (App.constants && App.constants.WANT_TYPES) || {};
            if (want.type === WT.food || want.type === WT.snack) {
                const entry = foodByName(want.item);
                if (entry) {
                    const ok = doFeed(entry);
                    return ok
                        ? "erfuellt seinen Wunsch nach " + entry.name
                        : "verweigert das gewuenschte " + entry.name;
                }
            }
            // playdate / item / minigame: in Stufe 1 noch nicht automatisiert
            return "hat einen Wunsch, den der Agent noch nicht erfuellen kann";
        },
        bathe() {
            ensureHomeScene();
            try { Activities.bathe(); } catch (e) {}
            return "nimmt ein Bad";
        },
        clean_room() {
            ensureHomeScene();
            try { App.handlers.clean(); } catch (e) {}
            return "raeumt sein Zimmer auf";
        },
        use_toilet() {
            ensureHomeScene();
            try { Activities.poop(); } catch (e) {}
            return "geht auf die Toilette";
        },
        sleep() {
            ensureHomeScene();
            try { App.pet.sleep(); } catch (e) {}
            return "legt sich schlafen";
        },
        praise() {
            try { App.pet.praise(); } catch (e) {}
            return "wird gelobt";
        },
        scold() {
            // Nur sinnvoll gegen echtes Fehlverhalten, sonst sinkt die Pflege.
            if (!App.pet.stats.is_misbehaving) {
                return "wollte schimpfen, aber es gab keinen Grund";
            }
            try { App.pet.scold(); } catch (e) {}
            return "wird ermahnt";
        },
    };

    const ACTION_HELP = [
        "idle: nichts tun, nur beobachten",
        "fulfill_want: den aktuellen Wunsch erfuellen (nur wenn ein Wunsch da ist)",
        "feed_food: fuettern; ziel = Name eines Futters, leer = passendes Futter waehlen",
        "bathe: baden (gegen Schmutz)",
        "clean_room: Zimmer aufraeumen (gegen Schmutz und Haeufchen)",
        "use_toilet: auf die Toilette (wenn die Blase voll ist)",
        "sleep: schlafen legen (wenn muede)",
        "praise: loben (hebt Disziplin bei gutem Verhalten)",
        "scold: ermahnen (nur bei Fehlverhalten)",
    ].join("\n");

    // ---- Reflex-Layer (Ueberlebensinstinkt, Hysterese) -----------------------
    // Gibt {acted, label} zurueck. acted=true bedeutet: Reflex hat gehandelt, LLM pausiert.
    function runReflex(cfg) {
        if (!cfg.reflex.enabled) return { acted: false };
        const s = App.pet.stats;

        // Tod zuerst
        if (s.is_dead) {
            if (cfg.reflex.autoRevive) {
                const revived = tryRevive();
                return { acted: true, label: revived ? "INSTINKT: wiederbelebt" : "tot, kann nicht wiederbeleben" };
            }
            return { acted: true, label: "tot" };
        }

        const R = cfg.reflex;
        const act = state.reflexActive;

        // Hysterese-Helfer fuer "niedrig ist schlecht"
        function low(name, cur, conf, fn, label) {
            if (act[name]) {
                if (cur >= conf.release) { act[name] = false; return null; }
            } else if (cur < conf.low) {
                act[name] = true;
            }
            if (act[name]) { fn(); return label; }
            return null;
        }
        // Hysterese-Helfer fuer "hoch ist schlecht" (Blase)
        function high(name, cur, conf, fn, label) {
            if (act[name]) {
                if (cur <= conf.release) { act[name] = false; return null; }
            } else if (cur > conf.high) {
                act[name] = true;
            }
            if (act[name]) { fn(); return label; }
            return null;
        }

        let label = null;

        label = low("health", s.current_health, R.health, () => {
            const med = foodByName("medicine") || pickFood("health_replenish");
            if (med) doFeed(med);
        }, "INSTINKT: Gesundheit kritisch, Medizin");
        if (label) return note(label);

        label = low("hunger", s.current_hunger, R.hunger, () => {
            const f = pickFood("hunger_replenish");
            if (f) doFeed(f);
        }, "INSTINKT: Hunger kritisch, fuettert");
        if (label) return note(label);

        label = high("bladder", s.current_bladder, R.bladder, () => {
            actions.use_toilet();
        }, "INSTINKT: Blase voll, Toilette");
        if (label) return note(label);

        label = low("cleanliness", s.current_cleanliness, R.cleanliness, () => {
            actions.bathe();
            actions.clean_room();
        }, "INSTINKT: zu schmutzig, Baden");
        if (label) return note(label);

        // Schlaf nur erzwingen, wenn ohnehin Schlafenszeit ist
        let sleepHour = false;
        try { sleepHour = App.isSleepHour(); } catch (e) {}
        if (sleepHour && !s.is_sleeping) {
            label = low("sleep", s.current_sleep, R.sleep, () => {
                actions.sleep();
            }, "INSTINKT: uebermuedet, schlafen");
            if (label) return note(label);
        }

        return { acted: false };
    }

    function note(label) {
        state.lastReflexNote = label;
        return { acted: true, label };
    }

    function tryRevive() {
        // Defensive Wiederbelebung: nur wenn im Spiel ein Weg existiert.
        try {
            const s = App.pet.stats;
            if (!s.is_revived_once) {
                s.is_dead = false;
                s.is_revived_once = true;
                s.current_health = App.pet.stats.max_health;
                s.current_hunger = 60;
                s.current_death_tick = App.pet.stats.max_death_tick;
                try { App.reloadScene(); } catch (e) {}
                try { App.save(); } catch (e) {}
                return true;
            }
        } catch (e) {}
        return false;
    }

    // ---- Zustand fuer das LLM serialisieren ----------------------------------
    function snapshot() {
        const s = App.pet.stats;
        const want = s.current_want || {};
        const WT = (App.constants && App.constants.WANT_TYPES) || {};
        let wantType = "keiner";
        for (const k in WT) if (WT[k] === want.type) wantType = k;
        return {
            name: App.petDefinition.name,
            lebensphase: lifeStageName(),
            hunger: Math.round(s.current_hunger),
            laune: Math.round(s.current_fun),
            gesundheit: Math.round(s.current_health),
            sauberkeit: Math.round(s.current_cleanliness),
            blase: Math.round(s.current_bladder),
            schlaf: Math.round(s.current_sleep),
            disziplin: Math.round(s.current_discipline),
            pflege: s.current_care + "/" + s.max_care,
            schlaeft: !!s.is_sleeping,
            benimmt_sich_daneben: !!s.is_misbehaving,
            zahnschmerzen: !!s.has_toothache,
            wunsch: want.type ? { art: wantType, ziel: want.item } : null,
        };
    }

    // ---- LLM-Aufruf ----------------------------------------------------------
    async function askLLM(cfg, snap) {
        const sys =
            cfg.persona.systemPrompt +
            "\n\nDu kannst genau eine Aktion pro Zug waehlen. Verfuegbare Aktionen:\n" +
            ACTION_HELP +
            "\n\nAntworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau diesem Format, ohne weiteren Text:\n" +
            '{"gedanke": "kurzer Gedanke in der Ich-Perspektive auf ' + cfg.persona.language + '", "aktion": "einer der Aktionsnamen", "ziel": "optionaler Futtername oder leer"}';

        let histText = "";
        if (state.history.length) {
            histText =
                "\n\nWas zuletzt geschah:\n" +
                state.history
                    .slice(-cfg.agent.historyLength)
                    .map((h) => "- " + (h.kind === "reflex" ? "[Instinkt] " : "") + h.text)
                    .join("\n");
        }
        let reflexText = "";
        if (state.lastReflexNote) {
            reflexText =
                "\n\nWichtig: Dein Ueberlebensinstinkt hat eben automatisch eingegriffen (" +
                state.lastReflexNote +
                "). Beziehe das in deinen Gedanken ein.";
            state.lastReflexNote = null;
        }

        const user =
            "Dein aktueller Zustand (Werte 0 bis 100):\n" +
            JSON.stringify(snap, null, 2) +
            histText +
            reflexText +
            "\n\nWas tust du als Naechstes?";

        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), cfg.llm.timeoutMs);
        let resp;
        try {
            const headers = { "Content-Type": "application/json" };
            if (cfg.llm.apiKey) headers["Authorization"] = "Bearer " + cfg.llm.apiKey;
            // OpenRouter erwartet diese beiden Header fuer die Zuordnung der Anfragen
            if (cfg.llm.provider === "openrouter") {
                if (cfg.llm.refererUrl) headers["HTTP-Referer"] = cfg.llm.refererUrl;
                if (cfg.llm.appTitle) headers["X-Title"] = cfg.llm.appTitle;
            }
            resp = await fetch(cfg.llm.baseUrl.replace(/\/$/, "") + "/chat/completions", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: cfg.llm.model,
                    temperature: cfg.llm.temperature,
                    max_tokens: cfg.llm.maxTokens,
                    messages: [
                        { role: "system", content: sys },
                        { role: "user", content: user },
                    ],
                }),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(to);
        }
        if (!resp.ok) {
            let detail = "";
            try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
            throw new Error("LLM HTTP " + resp.status + (detail ? ": " + detail : ""));
        }
        const data = await resp.json();
        const content =
            data.choices &&
            data.choices[0] &&
            data.choices[0].message &&
            data.choices[0].message.content;
        return parseDecision(content);
    }

    function parseDecision(content) {
        if (!content) return { gedanke: "(keine Antwort)", aktion: "idle", ziel: "" };
        let txt = String(content);
        // JSON aus moeglichem Fliesstext herausloesen
        const match = txt.match(/\{[\s\S]*\}/);
        if (match) txt = match[0];
        try {
            const obj = JSON.parse(txt);
            return {
                gedanke: obj.gedanke || obj.thought || "",
                aktion: obj.aktion || obj.action || "idle",
                ziel: obj.ziel || obj.target || "",
            };
        } catch (e) {
            return { gedanke: txt.slice(0, 160), aktion: "idle", ziel: "" };
        }
    }

    // ---- Haupt-Schleife ------------------------------------------------------
    async function tick() {
        if (state.busy) return;
        if (!gameReady()) {
            setOverlay({ status: "warte auf Spiel ...", thought: "", action: "" });
            return;
        }
        state.busy = true;
        const cfg = loadCfg();
        try {
            // 0) Ei-Phase: nur warten, das Spiel laesst es automatisch schluepfen
            if (App.pet.stats.is_egg) {
                setOverlay({ status: statusLine(), thought: "wartet auf das Schluepfen ...", action: "" });
                return;
            }

            // 1) Reflex zuerst
            const reflex = runReflex(cfg);
            if (reflex.acted) {
                pushHistory("reflex", reflex.label);
                state.lastAction = reflex.label;
                render(cfg, { reflex: reflex.label });
                return;
            }

            // 2) Persona (LLM)
            const snap = snapshot();
            let decision;
            try {
                decision = await askLLM(cfg, snap);
            } catch (e) {
                render(cfg, { error: "LLM nicht erreichbar: " + e.message });
                return;
            }

            const fn = actions[decision.aktion] || actions.idle;
            let result = "";
            try {
                result = fn.call(actions, decision.ziel);
            } catch (e) {
                result = "Aktion fehlgeschlagen";
            }

            state.lastThought = decision.gedanke;
            state.lastAction = decision.aktion + (decision.ziel ? " (" + decision.ziel + ")" : "");
            pushHistory("persona", (decision.gedanke ? decision.gedanke + " -> " : "") + result);
            render(cfg, { thought: decision.gedanke, action: result });
        } catch (e) {
            // Wichtig: Main.js setzt window.onerror und zeigt jeden Fehler als Popup.
            // Alles hier abfangen, damit der Agent den Spielbetrieb nie unterbricht.
            try {
                render(cfg, { error: "Agent-Fehler: " + (e && e.message ? e.message : e) });
            } catch (e2) {}
            if (window.console) console.warn("[DramawebAgent]", e);
        } finally {
            state.busy = false;
        }
    }

    function pushHistory(kind, text) {
        state.history.push({ kind, text });
        if (state.history.length > 40) state.history.shift();
    }

    function loop() {
        const cfg = loadCfg();
        // tick() ist async: Rejection hier abfangen, sonst wuerde window.onunhandledrejection
        // in Main.js ein Fehler-Popup ueber das Spiel legen.
        Promise.resolve()
            .then(tick)
            .catch(function (e) {
                if (window.console) console.warn("[DramawebAgent]", e);
            });
        state.timer = setTimeout(loop, Math.max(2000, cfg.agent.tickSeconds * 1000));
    }

    function start() {
        if (state.running) return;
        state.running = true;
        buildOverlay();
        loop();
        updateButtons();
    }

    function stop() {
        state.running = false;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        updateButtons();
        setOverlay({ status: "angehalten" });
    }

    // ---- Overlay -------------------------------------------------------------
    let el = {};

    function buildOverlay() {
        const cfg = loadCfg();
        if (!cfg.agent.overlay) return;
        if (el.root) return;
        const root = document.createElement("div");
        root.id = "dramaweb-agent-overlay";
        root.innerHTML =
            '<div class="dwa-bar">' +
            '<span class="dwa-lamp" id="dwa-lamp"></span>' +
            '<button id="dwa-toggle">Stop</button>' +
            '<a id="dwa-cfg" href="agent/config.html" target="_blank" rel="noopener">Config</a>' +
            '<span class="dwa-title">Dramaweb Agent</span>' +
            "</div>" +
            '<div class="dwa-status" id="dwa-status"></div>' +
            '<div class="dwa-thought" id="dwa-thought"></div>' +
            '<div class="dwa-action" id="dwa-action"></div>';
        document.body.appendChild(root);
        el.root = root;
        el.status = root.querySelector("#dwa-status");
        el.thought = root.querySelector("#dwa-thought");
        el.action = root.querySelector("#dwa-action");
        el.lamp = root.querySelector("#dwa-lamp");
        el.toggle = root.querySelector("#dwa-toggle");
        el.toggle.addEventListener("click", function () {
            if (state.running) stop(); else start();
        });
        injectStyles();
    }

    function statusLine() {
        if (!gameReady()) return "";
        const s = App.pet.stats;
        const f = (label, v) => label + " " + Math.round(v);
        return [
            App.petDefinition.name + " (" + lifeStageName() + ")",
            f("Hunger", s.current_hunger),
            f("Laune", s.current_fun),
            f("Gesund", s.current_health),
            f("Sauber", s.current_cleanliness),
            f("Blase", s.current_bladder),
            f("Schlaf", s.current_sleep),
            f("Diszip", s.current_discipline),
            "Pflege " + s.current_care + "/" + s.max_care,
        ].join("  |  ");
    }

    function render(cfg, info) {
        info = info || {};
        if (info.reflex) {
            setOverlay({
                status: statusLine(),
                reflex: info.reflex,
                thought: state.lastThought,
                action: "",
            });
            flashLamp();
        } else if (info.error) {
            setOverlay({ status: statusLine(), error: info.error });
        } else {
            setOverlay({
                status: statusLine(),
                thought: info.thought || "",
                action: info.action || "",
            });
        }
    }

    function setOverlay(o) {
        if (!el.root) return;
        if ("status" in o && el.status) el.status.textContent = o.status || "";
        if (el.thought) {
            if (o.error) {
                el.thought.textContent = o.error;
                el.thought.className = "dwa-thought dwa-err";
            } else if ("thought" in o) {
                el.thought.textContent = o.thought || "";
                el.thought.className = "dwa-thought";
            }
        }
        if (el.action && ("action" in o || "reflex" in o)) {
            el.action.textContent = o.reflex ? o.reflex : o.action || "";
            el.action.className = o.reflex ? "dwa-action dwa-reflex" : "dwa-action";
        }
    }

    function flashLamp() {
        if (!el.lamp) return;
        el.lamp.classList.add("on");
        setTimeout(() => el.lamp && el.lamp.classList.remove("on"), 1500);
    }

    function updateButtons() {
        if (el.toggle) el.toggle.textContent = state.running ? "Stop" : "Start";
    }

    function injectStyles() {
        if (document.getElementById("dwa-style")) return;
        const st = document.createElement("style");
        st.id = "dwa-style";
        st.textContent =
            "#dramaweb-agent-overlay{position:fixed;left:8px;bottom:8px;z-index:99999;" +
            "font-family:'Pixel','PixelOld',monospace;background:rgba(10,12,20,.82);color:#e8e8f0;" +
            "padding:8px 10px;border-radius:8px;max-width:min(92vw,520px);line-height:1.5;" +
            "box-shadow:0 2px 12px rgba(0,0,0,.5);font-size:12px;pointer-events:auto}" +
            "#dramaweb-agent-overlay .dwa-bar{display:flex;align-items:center;gap:8px;margin-bottom:4px}" +
            "#dramaweb-agent-overlay button,#dramaweb-agent-overlay a{font:inherit;cursor:pointer;" +
            "background:#2a2f45;color:#e8e8f0;border:1px solid #444a68;border-radius:5px;padding:2px 8px;text-decoration:none}" +
            "#dramaweb-agent-overlay .dwa-title{margin-left:auto;opacity:.6}" +
            "#dramaweb-agent-overlay .dwa-lamp{width:10px;height:10px;border-radius:50%;background:#394;" +
            "box-shadow:0 0 0 0 rgba(255,120,80,0);transition:.2s}" +
            "#dramaweb-agent-overlay .dwa-lamp.on{background:#ff6a3d;box-shadow:0 0 10px 3px rgba(255,120,80,.8)}" +
            "#dramaweb-agent-overlay .dwa-status{opacity:.8;font-size:11px;margin-bottom:4px}" +
            "#dramaweb-agent-overlay .dwa-thought{font-size:14px;color:#fff}" +
            "#dramaweb-agent-overlay .dwa-thought.dwa-err{color:#ff8a6a}" +
            "#dramaweb-agent-overlay .dwa-action{opacity:.75;font-style:italic;margin-top:2px}" +
            "#dramaweb-agent-overlay .dwa-action.dwa-reflex{color:#ff9a6a;opacity:1;font-style:normal}";
        document.head.appendChild(st);
    }

    // ---- Oeffentliche API + Autostart ----------------------------------------
    window.DramawebAgent = {
        start,
        stop,
        tickNow: tick,
        getConfig: loadCfg,
        getState: () => state,
        DEFAULT_CFG,
    };

    function boot() {
        const cfg = loadCfg();
        buildOverlay();
        setOverlay({ status: "bereit (Start druecken)", thought: "", action: "" });
        if (cfg.agent.autoStart) {
            const wait = setInterval(() => {
                if (gameReady()) {
                    clearInterval(wait);
                    start();
                }
            }, 1000);
        }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        setTimeout(boot, 500);
    } else {
        window.addEventListener("DOMContentLoaded", () => setTimeout(boot, 500));
    }
})();
