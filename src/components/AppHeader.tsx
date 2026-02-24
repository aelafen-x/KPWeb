import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAppContext } from "../store/AppContext";

export function AppHeader(): JSX.Element {
  const { auth, setAuth } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <header className="app-header">
      <div>
        <h1>DK Weekly Points</h1>
      </div>
      <nav>
        <Link className={location.pathname === "/wizard" ? "active" : ""} to="/wizard">
          Wizard
        </Link>
        <Link className={location.pathname === "/admin" ? "active" : ""} to="/admin">
          Admin
        </Link>
      </nav>
      <div className="user-box">
        <span>{auth?.email}</span>
        <button
          type="button"
          onClick={() => {
            setAuth(null);
            navigate("/login");
          }}
        >
          Sign Out
        </button>
      </div>
    </header>
  );
}
