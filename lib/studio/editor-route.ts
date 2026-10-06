/** Saved and example workspaces use the editor chrome; the introduction remains a site page. */
export const isStudioEditorRoute = (pathname: string) => /^\/build\/[^/]+\/?$/.test(pathname);
