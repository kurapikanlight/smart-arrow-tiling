import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {emptyState, transition, geometry, resize, removeWindow} from './layout.js';
import {SnapOverlay} from './snapOverlay.js';

const KEYS = ['LEFT', 'RIGHT', 'UP', 'DOWN'];
const SEQUENCE_DELAY_MS = 320;

export default class SmartArrowTilingExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._groups = [];
        this._windows = new Map();
        this._signals = [];
        this._bindings = [];
        this._shortcuts = [];
        this._edgeOverride = null;
        this._pending = null;
        this._keyTimer = 0;
        this._dragTimer = 0;
        this._grab = null;
        this._overlay = new SnapOverlay();
        try {
            this._takeShortcuts();
            for (const key of KEYS) {
                const name = `tile-${key.toLowerCase()}`;
                Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                    Shell.ActionMode.NORMAL, () => this._key(key));
                this._bindings.push(name);
            }
            this._connect(global.display, 'grab-op-begin', (_, win, op) => this._grabBegin(win, op));
            this._connect(global.display, 'grab-op-end', (_, win) => this._grabEnd(win));
            this._connect(global.display, 'notify::focus-window', () => this._cancelKey());
            this._connect(global.stage, 'captured-event', (_, event) => {
                if (this._grab && event.type() === Clutter.EventType.KEY_PRESS &&
                    event.get_key_symbol() === Clutter.KEY_Escape) {
                    this._grab.cancelled = true;
                    this._overlay.hide();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._connect(global.display, 'workareas-changed', () => {
                for (const group of this._groups) this._apply(group, this._grab?.win);
            });
            this._connect(Main.layoutManager, 'monitors-changed', () => this._resetGroups());
            this._connect(global.workspace_manager, 'active-workspace-changed', () => {
                this._cancelKey();
                this._stopDrag();
            });
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._cancelKey();
        this._stopDrag();
        for (const name of this._bindings ?? []) Main.wm.removeKeybinding(name);
        for (const [object, id] of this._signals ?? []) object.disconnect(id);
        this._signals = [];
        this._resetGroups();
        this._overlay?.destroy();
        this._overlay = null;
        // Preserve edits made by the user or another extension while enabled.
        for (const {settings, key, value, replacement} of this._shortcuts ?? []) {
            if (JSON.stringify(settings.get_strv(key)) !== JSON.stringify(replacement)) continue;
            if (value === null) settings.reset(key);
            else settings.set_value(key, value);
        }
        this._shortcuts = [];
        if (this._edgeOverride) {
            const {settings, value} = this._edgeOverride;
            if (!settings.get_boolean('edge-tiling')) {
                if (value === null) settings.reset('edge-tiling');
                else settings.set_value('edge-tiling', value);
            }
            this._edgeOverride = null;
        }
        this._bindings = [];
        this._settings = null;
    }

    _connect(object, name, callback) {
        this._signals.push([object, object.connect(name, callback)]);
    }

    _takeShortcuts() {
        const native = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        if (native.get_boolean('edge-tiling')) {
            this._edgeOverride = {settings: native, value: native.get_user_value('edge-tiling')};
            if (!native.set_boolean('edge-tiling', false)) throw new Error('Cannot release native edge tiling');
        }
        for (const schema_id of ['org.gnome.desktop.wm.keybindings', 'org.gnome.mutter.keybindings', 'org.gnome.shell.keybindings']) {
            const settings = new Gio.Settings({schema_id});
            for (const key of settings.settings_schema.list_keys()) {
                if (settings.get_value(key).get_type_string() !== 'as') continue;
                const bindings = settings.get_strv(key);
                const replacement = bindings.filter(accel => !/^<(super|mod4)>(left|right|up|down)$/i.test(accel));
                if (replacement.length === bindings.length) continue;
                const value = settings.get_user_value(key);
                this._shortcuts.push({settings, key, value, replacement});
                if (!settings.set_strv(key, replacement)) throw new Error(`Cannot release ${schema_id}:${key}`);
            }
        }
    }

    _supported(win) {
        return win && win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.is_fullscreen() && !win.is_on_all_workspaces() && win.allows_move() && (win.is_maximized() || win.allows_resize());
    }

    _key(key) {
        const win = global.display.get_focus_window();
        if (!this._supported(win) || this._grab) return;
        const pending = this._pending;
        this._cancelKey();
        const group = this._groups.find(g => g.workspace === win.get_workspace() && g.monitor === win.get_monitor());
        const sequence = pending?.win === win && pending.group === group && group.state === pending.after;
        if (key === 'UP' || key === 'DOWN') {
            this._command(win, sequence ? `${key}_${pending.key}` : key,
                null, win.get_monitor(), sequence ? pending.before : null);
            return;
        }
        if (sequence && pending.key === key) {
            this._command(win, `THIRD_${key}`, null, win.get_monitor(), pending.before);
            return;
        }
        const before = group?.state ?? emptyState();
        this._command(win, key);
        const current = this._windows.get(win)?.group;
        if (!current) return;
        // Act immediately; a second key refines the same logical starting state.
        this._pending = {win, key, group: current, before, after: current.state};
        this._keyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEQUENCE_DELAY_MS, () => {
            this._keyTimer = 0;
            this._pending = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelKey() {
        if (this._keyTimer) GLib.Source.remove(this._keyTimer);
        this._keyTimer = 0;
        this._pending = null;
    }

    _group(workspace, monitor) {
        let group = this._groups.find(g => g.workspace === workspace && g.monitor === monitor);
        if (!group) {
            group = {workspace, monitor, state: emptyState()};
            this._groups.push(group);
        }
        return group;
    }

    _command(win, command, layout = null, monitor = win.get_monitor(), baseState = null) {
        if (!this._supported(win)) return;
        const group = this._group(win.get_workspace(), monitor);
        const next = transition(baseState ?? group.state, win.get_id(), command, layout);
        if (baseState && next === baseState) return; // Unsupported refinement keeps the first move.
        if (!Object.values(next.slots).includes(win.get_id())) {
            if (Object.values(group.state.slots).every(id => id === null))
                this._groups = this._groups.filter(g => g !== group);
            return;
        }
        const record = this._windows.get(win);
        if (record && record.group !== group) this._detach(win);
        // Commit every slot before issuing even the first native move.
        group.state = next;
        if (!this._groups.includes(group)) this._groups.push(group);
        if (!this._windows.has(win)) this._track(win, group);
        this._windows.get(win).configured = null; // Explicit commands also repair client geometry drift.
        if (win.get_monitor() !== monitor) {
            this._windows.get(win).applying = true;
            win.move_to_monitor(monitor);
            this._windows.get(win).applying = false;
        }
        this._apply(group);
    }

    _track(win, group) {
        const record = {group, signals: [], idle: 0, applying: false, target: null, configured: null, animation: null};
        this._windows.set(win, record);
        const connect = (signal, fn) => record.signals.push(win.connect(signal, fn));
        connect('unmanaged', () => this._detach(win));
        connect('workspace-changed', () => this._validate(win));
        for (const prop of ['minimized', 'maximized-horizontally', 'maximized-vertically', 'fullscreen', 'on-all-workspaces', 'main-monitor'])
            connect(`notify::${prop}`, () => this._validate(win));
        connect('size-changed', () => {
            if (this._grab?.win !== win || this._grab.moving || record.applying) return;
            group.state = resize(group.state, win.get_id(), win.get_frame_rect(), this._area(group));
            this._apply(group, win);
        });
    }

    _validate(win) {
        const r = this._windows.get(win);
        if (!r || r.applying || this._grab?.win === win) return;
        if (!this._supported(win) || win.minimized || win.is_maximized() ||
            win.get_monitor() !== r.group.monitor || win.get_workspace() !== r.group.workspace)
            this._detach(win);
    }

    _detach(win, reflow = true) {
        const r = this._windows.get(win);
        if (!r) return;
        if (this._pending?.win === win) this._cancelKey();
        if (this._grab?.win === win) this._stopDrag(false);
        this._clearAnimation(r);
        this._windows.delete(win);
        if (r.idle) GLib.Source.remove(r.idle);
        for (const id of r.signals) win.disconnect(id);
        r.group.state = removeWindow(r.group.state, win.get_id());
        if (Object.values(r.group.state.slots).every(id => id === null))
            this._groups = this._groups.filter(g => g !== r.group);
        else if (reflow) this._apply(r.group);
    }

    _area(group) {
        return group.workspace.get_work_area_for_monitor(group.monitor);
    }

    _apply(group, skip = null) {
        const rectangles = geometry(group.state, this._area(group));
        for (const [win, record] of this._windows) {
            if (record.group !== group || win === skip) continue;
            const slot = Object.keys(group.state.slots).find(k => group.state.slots[k] === win.get_id());
            if (!slot) continue;
            const target = rectangles[slot];
            const equal = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(k => a[k] === b[k]);
            record.target = target;
            record.animate = !this._grab && !win.is_maximized() && (!record.idle || record.animate);
            if (record.idle) continue; // Keep one pending write, using the latest target.
            if (equal(record.configured, target) && !win.is_maximized()) continue;
            record.applying = true;
            try { if (win.is_maximized()) win.unmaximize(); }
            finally { record.applying = false; }
            record.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                record.idle = 0;
                if (!this._windows.has(win)) return GLib.SOURCE_REMOVE;
                const r = record.target;
                if (equal(record.configured, r)) return GLib.SOURCE_REMOVE;
                record.applying = true;
                try {
                    this._animateMove(win, record, r);
                    win.move_resize_frame(true, r.x, r.y, r.width, r.height);
                    record.configured = r;
                } catch (error) { console.error(`[Smart Arrow Tiling] ${error}`); }
                finally { record.applying = false; }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearAnimation(record) {
        const snapshot = record.animation;
        record.animation = null;
        snapshot?.destroy();
    }

    _animateMove(win, record, target) {
        this._clearAnimation(record);
        if (!record.animate || !St.Settings.get().enable_animations) return;
        // Animate an owned snapshot, never the compositor's live actor or its
        // transforms. Native geometry is submitted once, without waiting for this.
        const actor = win.get_compositor_private();
        const rect = win.get_frame_rect();
        if (!actor || rect.width <= 0 || rect.height <= 0 ||
            ['x', 'y', 'width', 'height'].every(k => rect[k] === target[k])) return;
        try {
            const snapshot = new St.Widget({content: actor.paint_to_content(rect), reactive: false});
            record.animation = snapshot;
            snapshot.set_position(rect.x, rect.y);
            snapshot.set_size(rect.width, rect.height);
            Main.uiGroup.add_child(snapshot);
            snapshot.ease({...target, opacity: 0, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (record.animation === snapshot) this._clearAnimation(record);
                }});
        } catch (error) {
            this._clearAnimation(record);
            console.error(`[Smart Arrow Tiling] Animation: ${error}`);
        }
    }

    _resetGroups() {
        this._cancelKey();
        this._stopDrag();
        for (const win of this._windows?.keys() ?? []) this._detach(win, false);
        this._groups = [];
    }

    _grabBegin(win, op) {
        this._cancelKey();
        this._stopDrag();
        if (!this._supported(win)) return;
        op &= ~Meta.GrabOp.WINDOW_FLAG_UNCONSTRAINED;
        const moving = op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
        const resizing = Object.keys(Meta.GrabOp).some(k => k.includes('RESIZING') && Meta.GrabOp[k] === op);
        if (!moving && !resizing) return;
        this._grab = {win, moving, drop: null, empty: emptyState(),
            unmanaged: win.connect('unmanaged', () => this._stopDrag(false))};
        const record = this._windows.get(win);
        if (record?.idle) { GLib.Source.remove(record.idle); record.idle = 0; }
        if (record) {
            record.configured = null;
            this._clearAnimation(record);
        }
        if (!moving) return;
        this._updateDrag();
        this._dragTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            this._updateDrag();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateDrag() {
        if (!this._grab?.moving || this._grab.cancelled) return;
        const [x, y] = global.get_pointer();
        const monitor = Main.layoutManager.monitors.findIndex(m => x >= m.x && y >= m.y && x < m.x + m.width && y < m.y + m.height);
        if (monitor < 0) { this._overlay.hide(); this._grab.drop = null; return; }
        const group = this._groups.find(g => g.workspace === this._grab.win.get_workspace() && g.monitor === monitor);
        const state = group?.state ?? this._grab.empty;
        const area = this._grab.win.get_workspace().get_work_area_for_monitor(monitor);
        this._grab.drop = this._overlay.update(x, y, area, state, this._grab.win.get_id(), monitor);
    }

    _grabEnd(win) {
        if (this._grab?.win !== win) return;
        this._updateDrag();
        const {moving, drop, cancelled} = this._grab;
        this._stopDrag(false);
        if (cancelled) {
            this._validate(win);
            const record = this._windows.get(win);
            if (record) this._apply(record.group);
        } else if (moving && drop) this._command(win, drop.zone, drop.layout, drop.monitor);
        else if (moving) this._detach(win);
        else {
            this._validate(win);
            const record = this._windows.get(win);
            if (record) {
                record.group.state = resize(record.group.state, win.get_id(), win.get_frame_rect(), this._area(record.group));
                this._apply(record.group);
            }
        }
    }

    _stopDrag(validate = true) {
        const grab = this._grab;
        this._grab = null;
        if (grab) grab.win.disconnect(grab.unmanaged);
        if (this._dragTimer) GLib.Source.remove(this._dragTimer);
        this._dragTimer = 0;
        this._overlay?.hide();
        if (validate && grab) this._validate(grab.win);
    }
}
