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
            maxTokens: 500,
            timeoutMs: 30000,
            jsonMode: true,
            // OpenRouter: Modelle wie DeepSeek denken sichtbar mit. Diese Tokens
            // zaehlen gegen max_tokens, dann bleibt fuer die Antwort nichts uebrig.
            disableReasoning: true,
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
        debug: {
            enabled: true,
            level: "normal",   // "normal" | "ausfuehrlich"
            toConsole: false,
            maxEntries: 300,
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
            // Bei allen Werten gilt: niedrig ist schlecht. Auch current_bladder
            // ist eine Reserve, 100 heisst "alles in Ordnung", 0 heisst "dringend".
            hunger: { low: 25, release: 60 },
            health: { low: 30, release: 70 },
            cleanliness: { low: 25, release: 60 },
            bladder: { low: 30, release: 60 },
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
        reflexWatch: {},      // Wirkungskontrolle je Beduerfnis
        poopCooldown: 0,
        toothCooldown: 0,
        busySince: 0,
        log: [],
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

    // --- Protokoll -----------------------------------------------------------
    // Haelt fest, was der Agent wollte und was tatsaechlich passiert ist. Die
    // Wirkungsmessung ist der eigentliche Zweck: Das Spiel lehnt Aktionen still
    // ab, ohne das Protokoll faellt das niemandem auf.
    const LOG_KEY = "DRAMAWEB_AGENT_LOG";

    function logWrite(type, text, data) {
        const cfg = loadCfg();
        if (!cfg.debug || !cfg.debug.enabled) return;
        const entry = {
            t: new Date().toISOString(),
            type: type,
            text: text,
        };
        if (data && cfg.debug.level === "ausfuehrlich") entry.data = data;
        else if (data && data.kurz) entry.data = data.kurz;

        state.log.push(entry);
        const max = cfg.debug.maxEntries || 300;
        while (state.log.length > max) state.log.shift();

        if (cfg.debug.toConsole && window.console) {
            console.log("[Agent] " + type + ": " + text, data || "");
        }
        try {
            localStorage.setItem(LOG_KEY, JSON.stringify(state.log));
        } catch (e) {}
    }

    // Kompakter Zustand fuer den Vorher-Nachher-Vergleich.
    function statSnapshot() {
        try {
            const s = App.pet.stats;
            return {
                satt: Math.round(s.current_hunger),
                laune: Math.round(s.current_fun),
                gesund: Math.round(s.current_health),
                sauber: Math.round(s.current_cleanliness),
                blase: Math.round(s.current_bladder),
                wach: Math.round(s.current_sleep),
                diszi: Math.round(s.current_discipline),
                pflege: s.current_care,
                gold: s.gold,
            };
        } catch (e) {
            return {};
        }
    }

    function statDiff(before, after) {
        const d = {};
        for (const k in after) {
            const v = (after[k] || 0) - (before[k] || 0);
            if (v) d[k] = (v > 0 ? "+" : "") + Math.round(v * 10) / 10;
        }
        return d;
    }

    // Ist das Spiel gerade beschaeftigt? Waehrend einer Animation, eines
    // offenen Dialogs oder einer laufenden Aktivitaet darf der Agent nicht
    // dazwischenfunken, sonst bricht er Ablaeufe ab und die Objekte der alten
    // Szene bleiben auf der Buehne liegen.
    function gameBusy() {
        try {
            if (App.disableGameplayControls) return "Animation laeuft";
            if (App.pet.isDuringScriptedState && App.pet.isDuringScriptedState())
                return "das Tier ist mitten in etwas";
            if (App.currentScene !== App.scene.home) return "noch nicht wieder zu Hause";
        } catch (e) {}
        return null;
    }

    // Notbremse, falls das Spiel laenger haengt: zurueck in den bedienbaren
    // Grundzustand.
    function recoverGame() {
        try { App.closeAllDisplays(); } catch (e) {}
        try { App.toggleGameplayControls(true); } catch (e) {}
        try { App.setScene(App.scene.home); } catch (e) {}
    }

    // --- Eingaben des Spielers nachbilden ------------------------------------
    // Mehrere Aktionen sind keine einmaligen Ablaeufe, sondern bleiben als
    // offener Zustand stehen (triggerScriptedState mit App.INF) und enden erst
    // durch echte Eingaben. Ohne sie haengt das Spiel, bis jemand von Hand
    // klickt. Nachgemessen im Spielcode:
    //   bathe       -> endet nach 10 Klicks aufs Spielfeld
    //   brushTeeth  -> jeder Klick gibt der Buerste Schwung, 8 Umdrehungen
    //   clean       -> der Mop muss nach rechts gezogen werden
    //   pet         -> ohne engageTimer wartet es unbegrenzt auf Streicheln
    // App.gameplayControlsOverwrite ist genau der Callback, den ein Klick
    // aufs Spielfeld ausloest, er laesst sich direkt aufrufen.
    function tapGame() {
        try {
            if (App.disableGameplayControls && App.gameplayControlsOverwrite) {
                App.gameplayControlsOverwrite();
                return true;
            }
        } catch (e) {}
        return false;
    }

    function tapRepeatedly(maxTaps, intervalMs) {
        let n = 0;
        const iv = setInterval(function () {
            n++;
            if (n > maxTaps || !tapGame()) clearInterval(iv);
        }, intervalMs || 250);
    }

    // Zieht die Maus ueber das Spielfeld und stellt den alten Zustand wieder her.
    function dragMouse(opts) {
        const m = App.mouse;
        if (!m) return;
        const before = { isDown: m.isDown, isInBounds: m.isInBounds };
        const steps = opts.steps || 30;
        let i = 0;
        const iv = setInterval(function () {
            if (i > steps) {
                clearInterval(iv);
                m.isDown = before.isDown;
                m.isInBounds = before.isInBounds;
                return;
            }
            const t = i / steps;
            m.isInBounds = true;
            m.isDown = true;
            m.x = opts.fromX + (opts.toX - opts.fromX) * t;
            m.y = opts.y;
            i++;
        }, opts.everyMs || 70);
    }

    function canvasSize() {
        const c = App.drawer && App.drawer.canvas;
        return { w: (c && c.width) || 96, h: (c && c.height) || 96 };
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
            if (want.type === WT.playdate) {
                // want.item ist der Index in der Freundesliste
                return actions.playdate(want.item);
            }
            if (want.type === WT.item) {
                return actions.use_item(want.item);
            }
            // Minispiele erwarten echte Eingaben und sind noch nicht automatisiert
            return "wuenscht sich ein Minispiel, das der Agent noch nicht spielen kann";
        },
        bathe() {
            // Bei Fehlverhalten verweigert das Tier das Bad.
            if (App.pet.stats.is_misbehaving) {
                return "weigert sich zu baden, es benimmt sich gerade daneben";
            }
            ensureHomeScene();
            try { Activities.bathe(); } catch (e) {}
            // Zehn Klicks beenden das Bad, sonst bleibt die Szene offen stehen.
            setTimeout(function () { tapRepeatedly(14, 260); }, 300);
            return "nimmt ein Bad";
        },
        clean_room() {
            ensureHomeScene();
            try { App.handlers.clean(); } catch (e) {}
            // Der Mop muss einmal quer nach rechts gezogen werden.
            setTimeout(function () {
                const c = canvasSize();
                dragMouse({ fromX: 0, toX: c.w, y: c.h * 0.73, steps: 30, everyMs: 70 });
            }, 600);
            return "raeumt sein Zimmer auf";
        },
        use_toilet() {
            // Das Spiel verweigert die Toilette, solange die Reserve ueber der
            // Haelfte liegt. Ohne diese Pruefung laeuft die Aktion ins Leere.
            const s = App.pet.stats;
            if (s.current_bladder > s.max_bladder / 2) {
                return "muss noch gar nicht, die Blase ist erst halb voll";
            }
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
        cuddle() {
            ensureHomeScene();
            // Der engageTimer ist zwingend: ohne ihn bleibt das Spiel
            // unbegrenzt im Streichelmodus stehen und wartet auf echte
            // Mauseingaben.
            try { Activities.pet(2000); } catch (e) {}
            return "laesst sich streicheln";
        },
        brush_teeth() {
            // Wichtig: bei Zahnschmerzen verweigert das Tier jedes Futter.
            try { Activities.brushTeeth(); } catch (e) {}
            // Jeder Klick gibt der Buerste Schwung, acht Umdrehungen beenden es.
            setTimeout(function () { tapRepeatedly(45, 150); }, 300);
            return "putzt sich die Zaehne";
        },
        have_birthday() {
            try { Activities.birthday(); } catch (e) {}
            return "feiert Geburtstag und wird aelter";
        },
        revive() {
            if (!App.pet.stats.is_dead) return "lebt doch noch";
            // Das Spiel erlaubt je Tier nur eine Wiederbelebung.
            if (App.pet.stats.is_revived_once) return "wurde schon einmal wiederbelebt";
            try { Activities.revive(); } catch (e) { return "Wiederbelebung fehlgeschlagen"; }
            return "wird wiederbelebt";
        },
        playdate(target) {
            const friends = App.petDefinition.friends || [];
            if (!friends.length) return "hat noch keine Freunde zum Verabreden";
            let friend = null;
            if (target !== undefined && target !== null && target !== "") {
                const idx = parseInt(target, 10);
                if (!isNaN(idx) && friends[idx]) friend = friends[idx];
                if (!friend) {
                    const lower = String(target).toLowerCase();
                    friend = friends.filter((f) => f && String(f.name).toLowerCase() === lower)[0] || null;
                }
            }
            if (!friend) friend = friends[Math.floor(Math.random() * friends.length)];
            try { Activities.invitePlaydate(friend); } catch (e) { return "die Verabredung klappte nicht"; }
            return "trifft sich mit " + friend.name;
        },
        use_item(target) {
            const items = App.definitions && App.definitions.item;
            if (!items || !target) return "weiss nicht, welchen Gegenstand";
            let key = items[target] ? target : null;
            if (!key) {
                const lower = String(target).toLowerCase();
                for (const k in items) {
                    if (k.toLowerCase() === lower) { key = k; break; }
                }
            }
            if (!key) return "kennt den Gegenstand " + target + " nicht";
            const def = items[key];
            // Das Spiel prueft beim Benutzen das Alter, also hier genauso.
            if (def.age && !def.age.includes(App.petDefinition.lifeStage)) {
                return key + " ist fuer dieses Alter nicht geeignet";
            }
            try {
                const merged = {};
                for (const p in def) merged[p] = def[p];
                merged.name = key;
                Activities.useItem(merged);
            } catch (e) {
                return "konnte " + key + " nicht benutzen";
            }
            return "benutzt " + key;
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
        "cuddle: streicheln lassen (hebt die Laune, immer moeglich)",
        "brush_teeth: Zaehne putzen (noetig bei Zahnschmerzen, sonst wird jedes Futter verweigert)",
        "playdate: sich mit einem Freund treffen; ziel = Name oder Nummer aus der Freundesliste, leer = zufaellig",
        "use_item: einen Gegenstand benutzen; ziel = Name des Gegenstands",
        "have_birthday: Geburtstag feiern und eine Lebensphase aelter werden",
        "revive: sich wiederbeleben (nur wenn tot)",
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

        // Hysterese-Helfer. Alle Beduerfnisse sind "niedrig ist schlecht".
        // Zusaetzlich eine Wirkungskontrolle: Bleibt ein Eingriff mehrfach
        // folgenlos (z.B. weil das Spiel die Aktion verweigert), wird dieser
        // Instinkt zeitweise ausgesetzt. Sonst wuerde er die Persona dauerhaft
        // blockieren, weil der Reflex Vorrang hat.
        function low(name, cur, conf, fn, label) {
            const w =
                state.reflexWatch[name] ||
                (state.reflexWatch[name] = { lastValue: null, failures: 0, blockedUntil: 0 });

            if (Date.now() < w.blockedUntil) return null;

            if (act[name]) {
                if (cur >= conf.release) {
                    act[name] = false;
                    w.failures = 0;
                    w.lastValue = null;
                    return null;
                }
                if (w.lastValue !== null && cur <= w.lastValue) {
                    w.failures++;
                    if (w.failures >= 3) {
                        act[name] = false;
                        w.failures = 0;
                        w.lastValue = null;
                        w.blockedUntil = Date.now() + 5 * 60 * 1000;
                        pushHistory(
                            "reflex",
                            "Instinkt '" + name + "' blieb wirkungslos und wird 5 Minuten ausgesetzt"
                        );
                        return null;
                    }
                } else {
                    w.failures = 0;
                }
            } else if (cur < conf.low) {
                act[name] = true;
                w.failures = 0;
            }

            if (act[name]) {
                w.lastValue = cur;
                fn();
                return label;
            }
            return null;
        }

        let label = null;

        // Zahnschmerzen zuerst: solange sie bestehen, verweigert das Tier
        // jedes Futter, der Hunger-Instinkt liefe sonst ins Leere.
        if (s.has_toothache && Date.now() > (state.toothCooldown || 0)) {
            state.toothCooldown = Date.now() + 60000;
            actions.brush_teeth();
            return note("INSTINKT: Zahnschmerzen, putzt die Zaehne");
        }

        // Haeufchen im Raum senkt laufend die Gesundheit, also zuerst wegraeumen.
        if (s.has_poop_out && Date.now() > (state.poopCooldown || 0)) {
            state.poopCooldown = Date.now() + 60000;
            actions.clean_room();
            return note("INSTINKT: Haeufchen im Raum, raeumt auf");
        }

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

        // Das Spiel verweigert die Toilette, solange die Reserve ueber der
        // Haelfte liegt, daher die Schwelle hart darunter halten.
        const bladderConf = {
            low: Math.min(R.bladder.low, 45),
            release: R.bladder.release,
        };
        label = low("bladder", s.current_bladder, bladderConf, () => {
            actions.use_toilet();
        }, "INSTINKT: muss dringend, Toilette");
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
        // Die eigene Wiederbelebung des Spiels nutzen, nicht die Flags von Hand
        // setzen. Das Spiel laesst genau eine Wiederbelebung je Tier zu.
        try {
            if (App.pet.stats.is_revived_once) return false;
            Activities.revive();
            return true;
        } catch (e) {
            return false;
        }
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
            saettigung: Math.round(s.current_hunger),
            laune: Math.round(s.current_fun),
            gesundheit: Math.round(s.current_health),
            sauberkeit: Math.round(s.current_cleanliness),
            blasen_reserve: Math.round(s.current_bladder),
            ausgeruht: Math.round(s.current_sleep),
            disziplin: Math.round(s.current_discipline),
            pflege: s.current_care + "/" + s.max_care,
            schlaeft: !!s.is_sleeping,
            benimmt_sich_daneben: !!s.is_misbehaving,
            zahnschmerzen: !!s.has_toothache,
            haeufchen_im_raum: !!s.has_poop_out,
            stubenrein: !!s.is_potty_trained,
            freunde: (App.petDefinition.friends || [])
                .slice(0, 8)
                .map((f, i) => i + ": " + (f && f.name ? f.name : "?")),
            wunsch: want.type
                ? {
                      art: wantType,
                      ziel: want.item,
                      erfuellbar: canFulfillWant(want),
                  }
                : null,
        };
    }

    // Kann der Agent diesen Wunsch ueberhaupt erfuellen? Minispiele erwarten
    // echte Eingaben und sind nicht automatisiert.
    function canFulfillWant(want) {
        const WT = (App.constants && App.constants.WANT_TYPES) || {};
        if (!want || !want.type) return false;
        if (want.type === WT.food || want.type === WT.snack) return true;
        if (want.type === WT.item) return true;
        if (want.type === WT.playdate) {
            return !!(App.petDefinition.friends && App.petDefinition.friends.length);
        }
        return false;
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
            "Dein aktueller Zustand. Alle Zahlenwerte gehen von 0 bis 100, und bei " +
            "allen gilt: hoch ist gut, niedrig ist schlecht und verlangt Handeln.\n" +
            "saettigung 90 heisst pappsatt, 10 heisst am Verhungern.\n" +
            "blasen_reserve 90 heisst alles in Ordnung, 10 heisst muss dringend zur Toilette.\n" +
            "Steht beim Wunsch erfuellbar auf false, kannst du ihn nicht erfuellen. Versuche ihn dann nicht, sondern tu etwas anderes Sinnvolles.\n" +
            "ausgeruht 90 heisst frisch, 10 heisst todmuede.\n" +
            "Die Toilette geht erst, wenn blasen_reserve unter 50 liegt, vorher weigert sich das Tier.\n\n" +
            JSON.stringify(snap, null, 2) +
            histText +
            reflexText +
            "\n\nWas tust du als Naechstes?";

        const headers = { "Content-Type": "application/json" };
        if (cfg.llm.apiKey) headers["Authorization"] = "Bearer " + cfg.llm.apiKey;
        // OpenRouter erwartet diese beiden Header fuer die Zuordnung der Anfragen
        if (cfg.llm.provider === "openrouter") {
            if (cfg.llm.refererUrl) headers["HTTP-Referer"] = cfg.llm.refererUrl;
            if (cfg.llm.appTitle) headers["X-Title"] = cfg.llm.appTitle;
        }
        const url = cfg.llm.baseUrl.replace(/\/$/, "") + "/chat/completions";
        const messages = [
            { role: "system", content: sys },
            { role: "user", content: user },
        ];

        async function call(useJsonMode) {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), cfg.llm.timeoutMs);
            const payload = {
                model: cfg.llm.model,
                temperature: cfg.llm.temperature,
                max_tokens: cfg.llm.maxTokens,
                messages: messages,
            };
            // Erzwingt gueltiges JSON. llama-server und die meisten
            // OpenRouter-Modelle unterstuetzen das.
            if (useJsonMode) payload.response_format = { type: "json_object" };
            if (cfg.llm.provider === "openrouter" && cfg.llm.disableReasoning !== false) {
                payload.reasoning = { enabled: false };
            }
            try {
                return await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload),
                    signal: ctrl.signal,
                });
            } finally {
                clearTimeout(to);
            }
        }

        const wantJson = cfg.llm.jsonMode !== false;
        const startMs = Date.now();
        let resp = await call(wantJson);
        // Endpunkte, die response_format nicht kennen, antworten mit 400 oder 422.
        // In diesem Fall einmal ohne den Parameter versuchen.
        if (!resp.ok && wantJson && (resp.status === 400 || resp.status === 422)) {
            resp = await call(false);
        }
        if (!resp.ok) {
            let detail = "";
            try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
            throw new Error("LLM HTTP " + resp.status + (detail ? ": " + detail : ""));
        }
        const data = await resp.json();
        logWrite("llm", "Antwort nach " + (Date.now() - startMs) + " ms", {
            kurz:
                "status " + resp.status +
                ", " + (data.choices && data.choices[0] ? data.choices[0].finish_reason : "?") +
                (data.usage ? ", " + data.usage.prompt_tokens + " rein / " + data.usage.completion_tokens + " raus" : ""),
            modell: data.model,
            usage: data.usage,
            rohantwort: data.choices && data.choices[0] && data.choices[0].message,
        });
        const choice = data.choices && data.choices[0];
        const msg = choice && choice.message;
        let content = msg && msg.content;

        // Notnagel: Hat das Modell nur gedacht und nichts geantwortet, versuchen
        // wir das JSON aus dem Gedankengang zu fischen.
        if (!content && msg && msg.reasoning) content = String(msg.reasoning);

        if (!content && choice && choice.finish_reason === "length") {
            throw new Error(
                "Antwort abgeschnitten: max_tokens zu klein, oder das Modell denkt zu lang. " +
                "Bei OpenRouter hilft der Schalter gegen das Mitdenken."
            );
        }
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

            // 0b) Offene Menues schliessen. Der Agent arbeitet direkt ueber die
            // Spielfunktionen, Menues sind fuer Menschen da und wuerden ihn sonst
            // bis zur Notbremse blockieren.
            try {
                if (App.haveAnyDisplays && App.haveAnyDisplays()) App.closeAllDisplays();
            } catch (e) {}

            // 0c) Laeuft im Spiel noch eine Animation, wird dieser Zug ausgelassen.
            const busy = gameBusy();
            if (busy) {
                if (!state.busySince) state.busySince = Date.now();
                if (Date.now() - state.busySince > 90000) {
                    recoverGame();
                    state.busySince = 0;
                    pushHistory("reflex", "Spiel haengt fest, zurueck in den Grundzustand");
                    render(cfg, { reflex: "INSTINKT: Spiel haengt fest, aufgeraeumt" });
                    return;
                }
                logWrite("warten", busy);
                setOverlay({ status: statusLine(), action: "wartet, " + busy });
                return;
            }
            state.busySince = 0;

            // 1) Reflex zuerst
            const vorReflex = statSnapshot();
            const reflex = runReflex(cfg);
            if (reflex.acted) {
                const self = vorReflex;
                setTimeout(function () {
                    logWrite("instinkt", reflex.label, {
                        vorher: self,
                        nachher: statSnapshot(),
                        bewirkt: statDiff(self, statSnapshot()),
                    });
                }, 3000);
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
                logWrite("fehler", "LLM nicht erreichbar: " + e.message);
                render(cfg, { error: "LLM nicht erreichbar: " + e.message });
                return;
            }

            const fn = actions[decision.aktion] || actions.idle;
            if (!actions[decision.aktion]) {
                logWrite("warnung", "unbekannte Aktion vom Modell: " + decision.aktion);
            }
            const vorAktion = statSnapshot();
            let result = "";
            try {
                result = fn.call(actions, decision.ziel);
            } catch (e) {
                result = "Aktion fehlgeschlagen";
                logWrite("fehler", "Aktion " + decision.aktion + " warf: " + (e && e.message));
            }
            // Wirkung erst nach der Animation messen.
            setTimeout(function () {
                const nach = statSnapshot();
                const diff = statDiff(vorAktion, nach);
                const ohneWirkung = Object.keys(diff).length === 0;
                logWrite(ohneWirkung ? "ohne-wirkung" : "aktion",
                    decision.aktion + (decision.ziel ? " (" + decision.ziel + ")" : "") + " -> " + result,
                    { kurz: ohneWirkung ? "nichts veraendert" : JSON.stringify(diff),
                      vorher: vorAktion, nachher: nach, gedanke: decision.gedanke });
            }, 6000);

            state.lastThought = decision.gedanke;
            state.lastAction = decision.aktion + (decision.ziel ? " (" + decision.ziel + ")" : "");
            pushHistory("persona", (decision.gedanke ? decision.gedanke + " -> " : "") + result);
            render(cfg, { thought: decision.gedanke, action: result });
        } catch (e) {
            // Wichtig: Main.js setzt window.onerror und zeigt jeden Fehler als Popup.
            // Alles hier abfangen, damit der Agent den Spielbetrieb nie unterbricht.
            try {
                logWrite("fehler", String((e && e.message) || e));
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
        logWrite("agent", "gestartet");
        buildOverlay();
        loop();
        updateButtons();
    }

    function stop() {
        if (state.running) logWrite("agent", "angehalten");
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
            '<a id="dwa-log" href="agent/log.html" target="_blank" rel="noopener">Log</a>' +
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
            f("Satt", s.current_hunger),
            f("Laune", s.current_fun),
            f("Gesund", s.current_health),
            f("Sauber", s.current_cleanliness),
            f("Blase", s.current_bladder),
            f("Wach", s.current_sleep),
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
        getLog: () => state.log.slice(),
        clearLog: () => {
            state.log.length = 0;
            try { localStorage.removeItem(LOG_KEY); } catch (e) {}
        },
        log: logWrite,
        DEFAULT_CFG,
    };

    function boot() {
        const cfg = loadCfg();
        try {
            const alt = localStorage.getItem(LOG_KEY);
            if (alt) state.log = JSON.parse(alt) || [];
        } catch (e) {}
        logWrite("agent", "Seite geladen");
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
