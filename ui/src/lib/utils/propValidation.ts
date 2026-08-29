export function assertRequiredFns(componentName: string, fns: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;

  for (const [propName, value] of Object.entries(fns)) {
    if (typeof value !== 'function') {
      console.error(
        `[${componentName}] required prop "${propName}" must be a function, got ${typeof value}. ` +
          `This callback will silently no-op when triggered — check the parent component's JSX.`
      );
    }
  }
}
