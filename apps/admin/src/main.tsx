import "./styles.css";
import { mount } from "./root.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
mount(root);
