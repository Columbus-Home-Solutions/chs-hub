import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/portal.css";
import "./styles/punch.css";
import "./styles/quote.css";
import { SubPage } from "./views/public/SubPage";
import { BidPage } from "./views/public/BidPage";
import { PacketPage } from "./views/public/PacketPage";

const root = document.getElementById("sub");
if (root) {
  // /packet/:token → PacketPage (Sprint 39 Run 1: sub onboarding packet)
  // /bid/:token    → BidPage    (Sprint 38 Run 3: bid solicitation)
  // /sub/:token    → SubPage    (Sprint 34: persistent sub punch items)
  const path = window.location.pathname;
  let view: preact.ComponentChild;
  if (path.startsWith("/packet")) {
    view = <PacketPage />;
  } else if (path.startsWith("/bid")) {
    view = <BidPage />;
  } else {
    view = <SubPage />;
  }
  render(view, root);
}
