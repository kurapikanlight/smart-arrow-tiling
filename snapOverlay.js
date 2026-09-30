import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {LAYOUTS, transition, geometry} from './layout.js';

// Presentation only: all previews and drops are evaluated by layout.js.
export class SnapOverlay {
    constructor() {
        this._bar = new St.Widget({style_class: 'smart-arrow-selector', reactive: false, visible: false});
        this._preview = new St.Widget({style_class: 'tile-preview smart-arrow-preview', reactive: false, visible: false});
        Main.layoutManager.addTopChrome(this._preview, {affectsStruts: false});
        Main.layoutManager.addTopChrome(this._bar, {affectsStruts: false});
        this._zones = [];
        this._shown = false;
        this._monitor = -1;
        for (const [layout, slots] of Object.entries(LAYOUTS)) {
            for (const zone of slots) {
                const actor = new St.Widget({style_class: 'smart-arrow-zone', reactive: false});
                this._bar.add_child(actor);
                this._zones.push({layout, zone, actor});
            }
        }
    }

    update(x, y, area, state, id, monitor) {
        if (this._monitor !== monitor) { this.hide(); this._monitor = monitor; }
        // Visible throughout a move grab; no hidden edge activation threshold.
        const stamp = [x, y, area.x, area.y, area.width, area.height, id, monitor].join(':');
        if (this._cache?.stamp === stamp && this._cache.state === state) return this._cache.drop;
        const scale = Math.min(1, area.width / 420);
        const width = 396 * scale;
        const bx = area.x + (area.width - width) / 2;
        const by = area.y + 12;
        this._bar.set_position(bx, by);
        this._bar.set_size(width, 80 * scale);
        if (!this._shown) {
            this._shown = true;
            this._bar.remove_all_transitions();
            this._bar.opacity = 0;
            this._bar.show();
            this._bar.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        const areaKey = [area.x, area.y, area.width, area.height].join(':');
        let drop = null;
        let active = null;
        for (const item of this._zones) {
            const index = Object.keys(LAYOUTS).indexOf(item.layout);
            const next = transition(state, id, item.zone, item.layout);
            const valid = next.layout === item.layout && next.slots[item.zone] === id;
            const miniature = geometry({...state, layout: item.layout}, {
                x: (12 + index * 96) * scale, y: 12 * scale, width: 84 * scale, height: 56 * scale,
            }, 0)[item.zone];
            const r = {...miniature, width: miniature.width - 4 * scale,
                height: miniature.height - (item.zone.length === 2 ? 4 * scale : 0)};
            item.actor.set_position(r.x, r.y);
            item.actor.set_size(r.width, r.height);
            item.actor.opacity = valid ? 255 : 65;
            const hovered = valid && x >= bx + r.x && x < bx + r.x + r.width && y >= by + r.y && y < by + r.y + r.height;
            if (hovered) {
                active = item;
                item.actor.add_style_pseudo_class('active');
                drop = {layout: item.layout, zone: item.zone, monitor};
                const target = geometry(next, area)[item.zone];
                if (this._active !== item || this._cache?.state !== state || this._cache?.area !== areaKey) {
                    if (!this._preview.visible) {
                        this._preview.set_position(target.x, target.y);
                        this._preview.set_size(target.width, target.height);
                        this._preview.opacity = 0;
                        this._preview.show();
                    }
                    this._preview.ease({...target, opacity: 255, duration: 100,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                }
            } else item.actor.remove_style_pseudo_class('active');
        }
        if (!drop) {
            this._preview.remove_all_transitions();
            this._preview.hide();
        }
        this._active = active;
        this._cache = {stamp, state, drop, area: areaKey};
        return drop;
    }

    hide() {
        this._cache = null;
        this._active = null;
        this._preview.remove_all_transitions();
        this._preview.hide();
        if (!this._shown) return;
        this._shown = false;
        this._bar.remove_all_transitions();
        this._bar.ease({opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { if (!this._shown) this._bar.hide(); }});
    }

    destroy() {
        for (const actor of [this._bar, this._preview]) {
            actor.remove_all_transitions();
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
    }
}
