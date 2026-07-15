import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import AboutPage from './pages/AboutPage';
import ContactPage from './pages/ContactPage';
import CriteriaPage from './pages/CriteriaPage';
import FaqPage from './pages/FaqPage';
import HomePage from './pages/HomePage';
import ProcessPage from './pages/ProcessPage';
import PrivacyPage from './pages/PrivacyPage';
import SellerConcernsPage from './pages/SellerConcernsPage';
import ThankYouPage from './pages/ThankYouPage';

const AdminLayout = lazy(() => import('./components/AdminLayout'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SecureDocumentsPage = lazy(() => import('./pages/SecureDocumentsPage'));

function RouteFallback() {
  return (
    <div className="section-shell mt-10">
      <div className="panel p-7 text-sm leading-7 text-ink/70">Loading...</div>
    </div>
  );
}

function ScrollToTop() {
  const location = useLocation();

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [location.pathname]);

  return null;
}

export default function App() {
  return (
    <>
      <ScrollToTop />

      <Routes>
        <Route element={<Layout />} path="/">
          <Route element={<HomePage />} index />
          <Route element={<AboutPage />} path="about" />
          <Route element={<CriteriaPage />} path="criteria" />
          <Route element={<SellerConcernsPage />} path="why-sell-to-me" />
          <Route element={<ProcessPage />} path="process" />
          <Route element={<FaqPage />} path="faq" />
          <Route element={<ContactPage />} path="contact" />
          <Route element={<PrivacyPage />} path="privacy" />
          <Route element={<ThankYouPage />} path="thank-you" />
          <Route
            element={
              <Suspense fallback={<RouteFallback />}>
                <SecureDocumentsPage />
              </Suspense>
            }
            path="secure-documents"
          />
        </Route>

        <Route
          element={
            <Suspense fallback={<RouteFallback />}>
              <AdminLayout />
            </Suspense>
          }
          path="/admin"
        >
          <Route
            element={
              <Suspense fallback={<RouteFallback />}>
                <DashboardPage />
              </Suspense>
            }
            index
          />
          <Route
            element={
              <Suspense fallback={<RouteFallback />}>
                <DashboardPage />
              </Suspense>
            }
            path="crm/:submissionId"
          />
          <Route
            element={
              <Suspense fallback={<RouteFallback />}>
                <DashboardPage />
              </Suspense>
            }
            path=":section"
          />
        </Route>

        <Route element={<Navigate replace to="/admin" />} path="dashboard" />

        <Route element={<Navigate replace to="/" />} path="*" />
      </Routes>
    </>
  );
}
