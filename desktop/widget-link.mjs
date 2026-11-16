// Widget links can select a dashboard section or a public YouTube channel.
export function widgetRoute(url) {
  if (url === 'arguspip://open' || url === 'arguspip://open/') return '';
  if (url === 'arguspip://sales' || url === 'arguspip://sales/') return '#apple/7';
  const youtube = /^arguspip:\/\/youtube(?:\/(UC[\w-]{22}))?\/?$/.exec(url);
  if (!youtube) return null;
  return youtube[1] ? '#youtube/' + youtube[1] : '#youtube';
}
