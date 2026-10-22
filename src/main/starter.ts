import type { OrbitConfig } from '../shared/types.ts';

/** The agent and skills Orbit runs when the config names none: the ones the orbit-starter plugin ships. */
export const STARTER = {
  storyAgent: 'orbit-starter:story-manager',
  storySkill: 'orbit-starter:story-engine',
  reviewSkill: 'orbit-starter:review-pr',
} as const;

/** The story agent and the story and review skills this config runs, the starter's where it names none. */
export function starterNames(config: Pick<OrbitConfig, 'storyAgent' | 'storySkill' | 'reviewSkill'>): {
  storyAgent: string;
  storySkill: string;
  reviewSkill: string;
} {
  return {
    storyAgent: config.storyAgent ?? STARTER.storyAgent,
    storySkill: config.storySkill ?? STARTER.storySkill,
    reviewSkill: config.reviewSkill ?? STARTER.reviewSkill,
  };
}
