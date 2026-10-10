/** The authenticated project directory and study editor use full-window workspace chrome. */
export const isStudioEditorRoute = (pathname: string) => /^\/build(?:\/[^/]+)?\/?$/.test(pathname);
