import React from 'react';
import { createRoot } from 'react-dom/client';
import { FilePane } from '../src/renderer/components/FilePane';
import { Markdown } from '../src/renderer/components/Markdown';
import { ChatImages } from '../src/renderer/remoteImages';
import '../src/renderer/styles.css';

// An isolated file preview using the real renderer with a synthetic image:fetch bridge.
const url = 'https://images.example.com/report/';
const calls: string[] = [];
const root = createRoot(document.getElementById('root')!);
const markdown = `# After\n\n![Release preview](${url}current.png)\n\n![Unavailable preview](${url}missing.png)`;
function draw() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 150;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#173549'; g.fillRect(0, 0, 640, 150);
  g.fillStyle = '#1f4759'; g.fillRect(24, 20, 592, 110);
  g.fillStyle = '#d7fbf2'; g.font = '600 24px system-ui'; g.fillText('Release preview', 48, 67);
  g.font = '16px system-ui'; g.fillText('Synthetic image for the Markdown preview test', 48, 98);
  return canvas.toDataURL();
}
Object.assign(window, {
  nekko: {
    readFile: async () => ({ content: markdown, binary: false, truncated: false }),
    listComments: async () => [],
    fetchRemoteImage: async (address: string) => {
      calls.push(address);
      if (address.endsWith('/missing.png') && calls.filter((u) => u === address).length === 1) throw new Error('HTTP 404');
      return { dataUrl: draw(), mime: 'image/png', bytes: 1, finalUrl: address };
    },
  },
  fixture: {
    calls,
    open: (file: string) => root.render(<FilePane path={`/demo/${file}.md`} readOnly />),
    chat: () => root.render(<ChatImages.Provider value={{ trusted: (address) => address.endsWith('/trusted.png'), open: () => {}, menu: () => {} }}>
      <Markdown text={`![Trusted](${url}trusted.png)\n\n![Model-only](${url}model.png)`} />
    </ChatImages.Provider>),
  },
});
root.render(<FilePane path="/demo/report.md" readOnly />);
