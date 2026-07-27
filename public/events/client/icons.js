const PATHS = {
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.8v5.1"/><path d="M12 16.2h.01"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.5 2.5L16.5 9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
    favorite: '<path d="M12 20.2 4.8 13a4.8 4.8 0 0 1 6.8-6.8L12 6.6l.4-.4a4.8 4.8 0 0 1 6.8 6.8Z"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    hidden: '<path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7"/><path d="M9.9 4.5A10.7 10.7 0 0 1 21 12a11.9 11.9 0 0 1-3 4.2M6.2 6.2A11.6 11.6 0 0 0 3 12a10.7 10.7 0 0 0 9 7 9.7 9.7 0 0 0 2.2-.3"/>',
    location: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
};
export function icon(name, className = "icon") {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
}
//# sourceMappingURL=icons.js.map