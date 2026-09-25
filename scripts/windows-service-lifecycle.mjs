export function planWindowsLifecycle(input) {
  if (!input || (input.role !== 'server+terminal' && input.role !== 'terminal')) {
    throw new Error('WINDOWS_ROLE_INVALID');
  }
  if (typeof input.preserveData !== 'boolean') throw new Error('WINDOWS_DATA_CHOICE_REQUIRED');
  const root = String(input.dataRoot ?? '');
  if (!/^[A-Za-z]:\\ProgramData\\ZAIPOS(?:\\|$)/.test(root) || root.includes('..')) {
    throw new Error('WINDOWS_DATA_ROOT_UNSAFE');
  }
  return {
    installPostgres: input.role === 'server+terminal',
    listen: '127.0.0.1',
    preserveData: input.preserveData,
    deleteDataOnUninstall: input.action === 'uninstall' && input.preserveData === false,
    upgradeKeepsData: input.action === 'upgrade',
  };
}
