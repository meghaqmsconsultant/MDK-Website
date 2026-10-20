
import { useEffect, useState } from 'react';
import { X, ArrowUpRight } from 'lucide-react';

const STORAGE_KEY = 'mdk-diwali-popup-shown';

export default function DiwaliPopup() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    sessionStorage.removeItem(STORAGE_KEY);

    const timer = window.setTimeout(() => {
      sessionStorage.setItem(STORAGE_KEY, 'yes');
      setVisible(true);
    }, 4000);

    return () => window.clearTimeout(timer);
  }, []);

  function closePopup() {
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      className="diwali-overlay"
      onClick={closePopup}
      role="presentation"
    >
      <section
        className="diwali-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diwali-popup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="diwali-close"
          type="button"
          onClick={closePopup}
          aria-label="Close Diwali offer"
        >
          <X size={22} />
        </button>

        <a
          className="diwali-poster-link"
          href="/contact?offer=diwali"
          onClick={closePopup}
          aria-label="Book the Diwali training offer"
        >
          <img
            src="/diwali_offer.jpeg"
            alt="MDK Diwali offer for corporate Quality Compliance training"
          />
        </a>

        <h2 id="diwali-popup-title">
          Celebrate Diwali with MDK
        </h2>

        <p>
          Book your corporate Quality Compliance training session.
        </p>

        <a
          className="button diwali-book-button"
          href="/contact?offer=diwali"
          onClick={closePopup}
        >
          Book Your Training <ArrowUpRight size={18} />
        </a>
      </section>
    </div>
  );
}
