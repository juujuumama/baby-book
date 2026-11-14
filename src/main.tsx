import { render } from 'preact';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource-variable/nunito';
import './styles.css';
import { App } from './app';

render(<App />, document.getElementById('app')!);
