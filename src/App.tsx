import { Navigate, Route, Routes } from "react-router-dom";
import { useAppContext } from "./store/AppContext";
import { LoginPage } from "./pages/LoginPage";
import { WizardPage } from "./pages/WizardPage";
import { AdminPage } from "./pages/AdminPage";

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
        path="/wizard"
        element={
          <Protected>
            <WizardPage />
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
      <Route path="*" element={<Navigate to="/wizard" replace />} />
    </Routes>
  );
}

