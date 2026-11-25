export function initApp(): void {
  const root = document.getElementById('app');
  if (root === null) {
    return;
  }
  root.dataset['engine'] = 'opengt2';
}

initApp();
