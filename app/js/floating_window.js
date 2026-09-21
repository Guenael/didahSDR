/**
 * didahSDR - Draggable floating window (SNR-Meter, W-Config)
 *
 * Toggle button in the top bar, close button, header drag with viewport clamping; position and
 * visibility persisted in localStorage under `${storageKey}_visible|_top|_left`.
 * Returns { show, hide, toggle, isVisible }; `onVisibilityChange(visible)` fires on every change.
 */
function setupFloatingWindow({ windowId, headerId, closeBtnId, toggleBtnId, storageKey, defaultVisible, defaultPos, onVisibilityChange }) {
    const el = document.getElementById(windowId);
    const header = document.getElementById(headerId);
    const closeBtn = document.getElementById(closeBtnId);
    const toggleBtn = document.getElementById(toggleBtnId);
    if (!el || !header) return null;

    let visible = localStorage.getItem(`${storageKey}_visible`);
    visible = visible === null ? !!defaultVisible : visible === 'true';

    const apply = () => {
        el.style.display = visible ? 'flex' : 'none';
        if (toggleBtn) toggleBtn.classList.toggle('active', visible);
        localStorage.setItem(`${storageKey}_visible`, String(visible));
        if (onVisibilityChange) onVisibilityChange(visible);
    };
    const clamp = () => {
        if (!visible) return;
        const rect = el.getBoundingClientRect();
        const left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, rect.left));
        const top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, rect.top));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = 'auto';
    };

    const storedTop = localStorage.getItem(`${storageKey}_top`);
    const storedLeft = localStorage.getItem(`${storageKey}_left`);
    if (storedTop && storedLeft) {
        el.style.top = storedTop;
        el.style.left = storedLeft;
        el.style.right = 'auto';
    } else {
        Object.assign(el.style, defaultPos || {});
    }
    apply();

    if (closeBtn) closeBtn.addEventListener('click', () => { visible = false; apply(); });
    if (toggleBtn) toggleBtn.addEventListener('click', () => { visible = !visible; apply(); });
    window.addEventListener('resize', clamp);

    let dragging = false, startX = 0, startY = 0, winX = 0, winY = 0;
    const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, winX + e.clientX - startX));
        const top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, winY + e.clientY - startY));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = 'auto';
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        localStorage.setItem(`${storageKey}_left`, el.style.left);
        localStorage.setItem(`${storageKey}_top`, el.style.top);
    };
    header.addEventListener('pointerdown', (e) => {
        if (closeBtn && (e.target === closeBtn || closeBtn.contains(e.target))) return;
        e.preventDefault();
        dragging = true;
        const rect = el.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY; winX = rect.left; winY = rect.top;
        el.classList.add('dragging');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    });

    return {
        show: () => { visible = true; apply(); },
        hide: () => { visible = false; apply(); },
        toggle: () => { visible = !visible; apply(); },
        isVisible: () => visible
    };
}

if (typeof module !== 'undefined') module.exports = setupFloatingWindow;
