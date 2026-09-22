import { setupPage } from './common';
import { mountPreview } from './preview';

setupPage();
const preview = document.getElementById('preview-app');
if (preview) mountPreview(preview);
