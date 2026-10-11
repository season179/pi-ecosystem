import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import herdrExtension from './herdr.js';
import shellExtension from './shell.js';

export default function extension(pi: ExtensionAPI): void {
  shellExtension(pi);
  herdrExtension(pi);
}
