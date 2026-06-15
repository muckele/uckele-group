import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AdminLayout from './components/AdminLayout';
import Layout from './components/Layout';
import AboutPage from './pages/AboutPage';
import ContactPage from './pages/ContactPage';
import CriteriaPage from './pages/CriteriaPage';
import DashboardPage from './pages/DashboardPage';
import FaqPage from './pages/FaqPage';
import HomePage from './pages/HomePage';
import PrivacyPage from './pages/PrivacyPage';
import ProcessPage from './pages/ProcessPage';
import SecureDocumentsPage from './pages/SecureDocumentsPage';
import SellerConcernsPage from './pages/SellerConcernsPage';
import TermsPage from './pages/TermsPage';

function ScrollToTop() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
          <Route element={<CriteriaPage />} path="services" />
          <Route element={<SellerConcernsPage />} path="why-partner" />
          <Route element={<ProcessPage />} path="process" />
          <Route element={<FaqPage />} path="faq" />
          <Route element={<ContactPage />} path="contact" />
          <Route element={<PrivacyPage />} path="privacy" />
          <Route element={<TermsPage />} path="terms" />
          <Route element={<SecureDocumentsPage />} path="secure-documents" />
        </Route>

        <Route element={<AdminLayout />} path="/admin">
          <Route element={<DashboardPage />} index />
        </Route>

        <Route element={<Navigate replace to="/services" />} path="criteria" />
        <Route element={<Navigate replace to="/why-partner" />} path="why-sell-to-me" />
        <Route element={<Navigate replace to="/admin" />} path="dashboard" />

        <Route element={<Navigate replace to="/" />} path="*" />
      </Routes>
    </>
  );
}
