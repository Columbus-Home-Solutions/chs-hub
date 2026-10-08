import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/portal.css";
import "./styles/punch.css";
import "./styles/checkin.css";
import "./styles/quote.css";
import { SubPage } from "./views/public/SubPage";
import { CheckInPunch, CheckInSchedule } from "./views/public/CheckInPage";
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
    const parts = path.split("/").filter(Boolean);
    const token = parts[1] ? decodeURIComponent(parts[1]) : "";
    if (parts[0] === "sub" && parts[2] === "schedule") view = <CheckInSchedule token={token} />;
    else if (parts[0] === "sub" && parts[2] === "punch") view = <CheckInPunch token={token} />;
    else view = <SubPage />;
  }
  render(view, root);
}
