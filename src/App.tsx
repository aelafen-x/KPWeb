import { Navigate, Route, Routes } from "react-router-dom";
import { useAppContext } from "./store/AppContext";
import { LoginPage } from "./pages/LoginPage";
import { AdminPage } from "./pages/AdminPage";
import { RosterPage } from "./pages/RosterPage";
import { WeeklyPage } from "./pages/WeeklyPage";

function Protected({ children }: { children: JSX.Element }): JSX.Element {
  const { auth } = useAppContext();
  if (!auth) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/weekly"
        element={
          <Protected>
            <WeeklyPage />
          </Protected>
        }
      />
      <Route
        path="/roster"
        element={
          <Protected>
            <RosterPage />
          </Protected>
        }
      />
      <Route
        path="/admin"
        element={
          <Protected>
            <AdminPage />
          </Protected>
        }
      />
      {/* Old bookmarks: the Wizard and the separate Weekly DKP page are now one page. */}
      <Route path="/wizard" element={<Navigate to="/weekly" replace />} />
      <Route path="/ledger" element={<Navigate to="/weekly" replace />} />
      <Route path="*" element={<Navigate to="/weekly" replace />} />
    </Routes>
  );
}
