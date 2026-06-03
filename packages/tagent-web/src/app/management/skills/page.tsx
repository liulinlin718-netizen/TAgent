'use client';

import { useEffect, useState } from 'react';
import { Plus, Search, BookOpen, Clock, Tag } from 'lucide-react';
import styles from './skills.module.css';

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger?: string;
  body: string;
  createdAt: number;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:3001/api/skills')
      .then(res => res.json())
      .then(data => {
        setSkills(data.skills);
        setLoading(false);
      });
  }, []);

  const filteredSkills = skills.filter(s => 
    s.name.toLowerCase().includes(search.toLowerCase()) || 
    s.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Skills 技能库</h1>
          <p className={styles.subtitle}>为您的 Agent 提供可复用的专业领域 SOP 与外挂记忆</p>
        </div>
        <button className={styles.primaryButton}>
          <Plus size={18} />
          新建 Skill
        </button>
      </header>

      <div className={styles.searchBar}>
        <Search size={20} className={styles.searchIcon} />
        <input 
          type="text" 
          placeholder="搜索技能名称或描述..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={styles.searchInput}
        />
      </div>

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <div className={styles.bentoGrid}>
          {filteredSkills.map(skill => (
            <div key={skill.id} className={styles.bentoCard}>
              <div className={styles.cardHeader}>
                <div className={styles.iconWrapper}>
                  <BookOpen size={20} />
                </div>
                <span className={styles.categoryBadge}>{skill.category}</span>
              </div>
              
              <h3 className={styles.cardTitle}>{skill.name}</h3>
              <p className={styles.cardDescription}>{skill.description}</p>
              
              <div className={styles.cardFooter}>
                <div className={styles.metaItem}>
                  <Clock size={14} />
                  <span>{new Date(skill.createdAt).toLocaleDateString()}</span>
                </div>
                {skill.trigger && (
                  <div className={styles.metaItem}>
                    <Tag size={14} />
                    <span>Trigger: {skill.trigger}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
          
          {filteredSkills.length === 0 && (
            <div className={styles.emptyState}>
              <p>未找到符合条件的 Skill</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
