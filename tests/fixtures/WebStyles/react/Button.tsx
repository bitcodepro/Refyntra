import React from 'react';
import styles from './Button.module.css';

export function Button({ primary }: { primary?: boolean }) {
  // styles.commented is not a use
  return (
    <button className={styles.root}>
      <span className={primary ? styles['primary'] : ''}>label</span>
      <i className="shared">icon</i>
    </button>
  );
}
