import { render } from "preact";

import { App } from "./App";
import { SystemWidget } from "./components/SystemWidget";
import "./index.css";

const isWidget = new URLSearchParams(window.location.search).get("widget") === "1";

render(isWidget ? <SystemWidget /> : <App />, document.getElementById("app") as HTMLElement);

