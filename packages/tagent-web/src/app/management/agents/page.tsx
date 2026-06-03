'use client';

import { useEffect, useState, useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { UserCog, Star, Link as LinkIcon, Shield, GripVertical } from 'lucide-react';
import { DndContext, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import styles from './agents.module.css';
import type { AgentCard } from '@tagent/core';

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
}

// Draggable Skill Badge
function DraggableSkill({ skill }: { skill: Skill }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `skill-${skill.id}`,
    data: { skill },
  });

  return (
    <div 
      ref={setNodeRef} 
      className={`${styles.draggableSkill} ${isDragging ? styles.dragging : ''}`}
      {...listeners} 
      {...attributes}
    >
      <GripVertical size={14} className={styles.dragHandle} />
      <span>{skill.name}</span>
      <span className={styles.skillCategory}>{skill.category}</span>
    </div>
  );
}

// Droppable Agent Card
function DroppableAgentCard({ agent, onUpdate }: { agent: AgentCard, onUpdate: () => void }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `agent-${agent.id}`,
    data: { agent },
  });

  const isDoc = agent.id === 'document-agent';
  const isResearch = agent.id === 'research-agent';
  const isData = agent.id === 'data-agent';
  
  const radarData = useMemo(() => [
    { subject: '分析能力', A: isData ? 95 : isResearch ? 85 : 60, fullMark: 100 },
    { subject: '文档撰写', A: isDoc ? 95 : 70, fullMark: 100 },
    { subject: '搜索调研', A: isResearch ? 95 : 70, fullMark: 100 },
    { subject: '逻辑推理', A: 85, fullMark: 100 },
    { subject: '创造力', A: isDoc ? 85 : 60, fullMark: 100 },
  ], [isDoc, isResearch, isData]);

  return (
    <div ref={setNodeRef} className={`${styles.agentCard} ${isOver ? styles.agentCardOver : ''}`}>
      <div className={styles.cardHeader}>
        <div className={styles.agentAvatar}>
          {agent.icon || <UserCog size={24} />}
        </div>
        <div className={styles.agentInfo}>
          <h3 className={styles.agentName}>{agent.name}</h3>
          <span className={styles.agentType}>常驻 Agent</span>
        </div>
        <div className={styles.statusDot} title={agent.state.business}></div>
      </div>
      
      <p className={styles.description}>{agent.description}</p>
      
      <div className={styles.radarContainer}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
            <PolarGrid stroke="var(--border)" />
            <PolarAngleAxis dataKey="subject" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
            <Radar name="能力" dataKey="A" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.3} />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.capabilitiesList}>
        <div className={styles.capSection}>
          <h4 className={styles.capTitle}><Star size={14}/> 绑定的 Skills</h4>
          <div className={styles.tags}>
            {agent.capabilities.skills?.length ? (
              agent.capabilities.skills.map(skill => (
                <span key={skill} className={styles.tag}>{skill}</span>
              ))
            ) : (
              <span className={styles.emptyTag}>尚未绑定 Skills，拖拽右侧技能到此卡片</span>
            )}
          </div>
        </div>
      </div>
      
      <div className={styles.governanceConstraints}>
        <Shield size={14} className={styles.shieldIcon} />
        <span>成本上限: ${agent.constraints.maxCostPerTask}</span>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);

  const loadData = async () => {
    const [agRes, skRes] = await Promise.all([
      fetch('http://localhost:3001/api/agents/resident'),
      fetch('http://localhost:3001/api/skills')
    ]);
    const agData = await agRes.json();
    const skData = await skRes.json();
    setAgents(agData.agents);
    setSkills(skData.skills);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleDragStart = (event: any) => {
    setActiveSkill(event.active.data.current?.skill);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveSkill(null);
    const { active, over } = event;
    if (!over) return;

    const skillId = active.id.toString().replace('skill-', '');
    const agentId = over.id.toString().replace('agent-', '');

    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    const currentSkills = agent.capabilities.skills || [];
    if (!currentSkills.includes(skillId)) {
      const newSkills = [...currentSkills, skillId];
      // API call to bind skill
      await fetch(`http://localhost:3001/api/agents/${agentId}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: newSkills })
      });
      loadData(); // Refresh UI
    }
  };

  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Agents 大厅</h1>
            <p className={styles.subtitle}>将右侧的 Skills 拖拽给 Agent 以赋予它们新能力</p>
          </div>
        </header>

        {loading ? (
          <div className={styles.loading}>加载中...</div>
        ) : (
          <div className={styles.splitView}>
            {/* Left: Agents */}
            <div className={styles.agentsArea}>
              <div className={styles.agentGrid}>
                {agents.map(agent => (
                  <DroppableAgentCard key={agent.id} agent={agent} onUpdate={loadData} />
                ))}
              </div>
            </div>

            {/* Right: Skills Sidebar */}
            <div className={styles.skillsSidebar}>
              <h3 className={styles.sidebarTitle}>可用 Skills (拖拽)</h3>
              <div className={styles.skillList}>
                {skills.map(skill => (
                  <DraggableSkill key={skill.id} skill={skill} />
                ))}
                {skills.length === 0 && (
                  <p className={styles.emptyTag}>请先在 Skills 库中创建技能</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={{ duration: 250, easing: 'ease' }}>
        {activeSkill ? (
          <div className={`${styles.draggableSkill} ${styles.dragOverlay}`}>
            <GripVertical size={14} className={styles.dragHandle} />
            <span>{activeSkill.name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
