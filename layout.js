// Pure slot ownership and geometry. No GNOME objects or asynchronous operations.
export const LAYOUTS = {
    TWO: ['L', 'R'],
    THREE_LEFT_PRIMARY: ['L', 'RT', 'RB'],
    THREE_RIGHT_PRIMARY: ['LT', 'LB', 'R'],
    FOUR: ['LT', 'LB', 'RT', 'RB'],
};
export const emptyState = () => ({layout: 'TWO', slots: {L: null, R: null}, split: .5, leftSplit: .5, rightSplit: .5});
const owners = s => Object.values(s.slots).filter(id => id !== null);
const slotOf = (s, id) => Object.keys(s.slots).find(k => s.slots[k] === id);
const clamp = n => Math.max(.1, Math.min(.9, n));

function columns(s) {
    return ['L', 'R'].map(side => side in s.slots ? [s.slots[side]] : [s.slots[`${side}T`], s.slots[`${side}B`]]);
}
function fromColumns(s, cols) {
    const layout = cols[0].length === 2
        ? (cols[1].length === 2 ? 'FOUR' : 'THREE_RIGHT_PRIMARY')
        : (cols[1].length === 2 ? 'THREE_LEFT_PRIMARY' : 'TWO');
    return {...s, layout, slots: Object.fromEntries(LAYOUTS[layout].map((k, i) => [k, cols.flat()[i]]))};
}

// Explicit layout/zone placement is also used by the snap assistant.
function place(s, id, zone, layout) {
    if (!LAYOUTS[layout]?.includes(zone)) return s;
    const remaining = owners(s).filter(v => v !== id);
    if (remaining.length >= LAYOUTS[layout].length) return s;
    if (s.layout === layout) {
        const slots = {...s.slots};
        const source = slotOf(s, id);
        const displaced = slots[zone];
        if (source) slots[source] = displaced;
        else if (displaced !== null) {
            const empty = Object.keys(slots).find(k => slots[k] === null && k !== zone);
            if (!empty) return s;
            slots[empty] = displaced;
        }
        slots[zone] = id;
        return {...s, slots};
    }
    const slots = Object.fromEntries(LAYOUTS[layout].map(k => [k, null]));
    slots[zone] = id;
    for (const k of LAYOUTS[layout]) {
        if (slots[k] === null && remaining.includes(s.slots[k])) {
            slots[k] = s.slots[k];
            remaining.splice(remaining.indexOf(slots[k]), 1);
        }
    }
    for (const k of LAYOUTS[layout]) if (slots[k] === null && remaining.length) slots[k] = remaining.shift();
    return {...s, layout, slots};
}

export function transition(s, id, command, layout = null) {
    if (layout) return place(s, id, command, layout);
    if (!['LEFT', 'RIGHT', 'UP', 'DOWN', 'UP_LEFT', 'UP_RIGHT', 'DOWN_LEFT', 'DOWN_RIGHT', 'THIRD_LEFT', 'THIRD_RIGHT'].includes(command)) return s;
    const source = slotOf(s, id);
    if (!source && owners(s).length >= 4) return s;
    const side = command.includes('LEFT') ? 'L' : command.includes('RIGHT') ? 'R' : source?.[0];
    if (!side) return s;
    if (command.startsWith('THIRD')) {
        if (owners(s).filter(v => v !== id).length > 2) return s;
        const count = owners(s).filter(v => v !== id).length + 1;
        const targetLayout = count <= 2 ? 'TWO' : side === 'L' ? 'THREE_LEFT_PRIMARY' : 'THREE_RIGHT_PRIMARY';
        return {...place(s, id, side, targetLayout), split: side === 'L' ? 1 / 3 : 2 / 3};
    }
    if (command === 'LEFT' || command === 'RIGHT') s = {...s, split: .5};
    const vertical = command.includes('UP') ? 'T' : command.includes('DOWN') ? 'B' : source?.[1];
    const cols = columns(s).map(c => [...c]);
    const ti = side === 'L' ? 0 : 1;
    const si = source?.[0] === 'L' ? 0 : 1;
    const target = cols[ti];
    const index = vertical === 'B' ? 1 : 0;

    if (!source) {
        if (target.length === 1 && target[0] === null) {
            cols[ti] = vertical ? (index === 0 ? [id, null] : [null, id]) : [id];
        }
        else if (target.length === 2 && target.includes(null)) {
            const wanted = vertical ? index : target.indexOf(null);
            if (target[wanted] !== null) target[1-wanted] = target[wanted];
            target[wanted] = id;
        } else if (target.length === 1 && !vertical && cols[1-ti].every(v => v === null)) {
            cols[1-ti] = [target[0]];
            cols[ti] = [id];
        } else if (target.length === 1) {
            const old = target[0];
            cols[ti] = index === 0 ? [id, old] : [old, id];
        } else {
            // Requested column is full: promote an empty slot in the other column.
            const opposite = cols[1-ti];
            const displaced = target[index];
            if (opposite.length === 1 && opposite[0] === null) opposite[0] = displaced;
            else if (opposite.length === 1) cols[1-ti] = [opposite[0], displaced];
            else opposite[opposite.indexOf(null)] = displaced;
            target[index] = id;
        }
        return fromColumns(s, cols);
    }
    if (si === ti) {
        if (target.length === 1 && vertical)
            cols[ti] = index === 0 ? [id, null] : [null, id];
        else if (target.length === 2 && vertical && source[1] !== vertical)
            [target[0], target[1]] = [target[1], target[0]];
        return fromColumns(s, cols);
    }
    if (source.length === 1 && !vertical) {
        [cols[0], cols[1]] = [cols[1], cols[0]];
        return {...fromColumns(s, cols), leftSplit: s.rightSplit, rightSplit: s.leftSplit};
    }
    if (target.length === 2) {
        const from = source.length === 1 ? 0 : source[1] === 'T' ? 0 : 1;
        [target[index], cols[si][from]] = [id, target[index]];
    } else if (cols[si].length === 2) {
        const old = target[0];
        cols[ti] = index === 0 ? [id, old] : [old, id];
        cols[si] = [cols[si][source[1] === 'T' ? 1 : 0]];
    } else {
        [cols[0], cols[1]] = [cols[1], cols[0]];
        if (vertical) cols[ti] = index === 0 ? [id, null] : [null, id];
    }
    return fromColumns(s, cols);
}

export function removeWindow(s, id) {
    const cols = columns(s).map(c => {
        const remaining = c.filter(v => v !== id && v !== null);
        return remaining.length ? remaining : [null];
    });
    return fromColumns(s, cols);
}

export function geometry(s, area, gap = 1) {
    const {x, y, width, height} = area;
    const boundary = (size, ratio) => Math.max(1, Math.min(size - gap - 1, Math.round(size * clamp(ratio))));
    const left = boundary(width, s.split);
    const result = {};
    for (const slot of LAYOUTS[s.layout]) {
        const isLeft = slot[0] === 'L';
        const h = boundary(height, isLeft ? s.leftSplit : s.rightSplit);
        result[slot] = {
            x: isLeft ? x : x + left + gap,
            y: slot[1] === 'B' ? y + h + gap : y,
            width: isLeft ? left : width - left - gap,
            height: slot.length === 1 ? height : slot[1] === 'T' ? h : height - h - gap,
        };
    }
    return result;
}

export function resize(s, id, rect, area, gap = 1) {
    const slot = slotOf(s, id);
    if (!slot) return s;
    const out = {...s};
    out.split = clamp(((slot[0] === 'L' ? rect.x + rect.width : rect.x - gap) - area.x) / area.width);
    if (slot.length === 2) {
        const key = slot[0] === 'L' ? 'leftSplit' : 'rightSplit';
        out[key] = clamp(((slot[1] === 'T' ? rect.y + rect.height : rect.y - gap) - area.y) / area.height);
    }
    return out;
}
