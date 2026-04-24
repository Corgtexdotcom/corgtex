"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Edge,
  Node,
} from "@xyflow/react";
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import CircleNode from "./CircleNode";
import ExpandedCircleNode from "./ExpandedCircleNode";
import CircleDetailPanel from "./CircleDetailPanel";
import "./circle-graph.css";

const nodeTypes = {
  circleNode: CircleNode,
  expandedCircleNode: ExpandedCircleNode,
};

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

// Helper to estimate size
function getNodeDimensions(isExpanded: boolean, roleCount: number) {
  if (!isExpanded) {
    return { width: 260, height: 100 };
  }
  // Base header size + roles space
  return { width: 400, height: 150 + (roleCount * 100) };
}

function getLayoutedElements(nodes: Node[], edges: Edge[], direction = 'TB') {
  dagreGraph.setGraph({ rankdir: direction, nodesep: 50, ranksep: 100 });

  nodes.forEach((node) => {
    const isExpanded = node.type === "expandedCircleNode";
    const roleCount = (node.data as any).roles?.length || 0;
    const { width, height } = getNodeDimensions(isExpanded, roleCount as number);
    dagreGraph.setNode(node.id, { width, height });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const newNode = { ...node };

    const isExpanded = node.type === "expandedCircleNode";
    const roleCount = (node.data as any).roles?.length || 0;
    const { width, height } = getNodeDimensions(isExpanded, roleCount as number);

    // Dagre returns center coordinates, we need to adapt to top-left
    newNode.position = {
      x: nodeWithPosition.x - width / 2,
      y: nodeWithPosition.y - height / 2,
    };

    return newNode;
  });

  return { nodes: newNodes, edges };
}

export default function CircleGraph({ treeData, isDemo }: { treeData: any[]; isDemo: boolean }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);
  const [expandedCircleIds, setExpandedCircleIds] = useState<Set<string>>(new Set());

  // Flatten the tree to a single array of items with parent associations
  const flattenTree = useCallback((nodes: any[]): any[] => {
    let result: any[] = [];
    nodes.forEach(node => {
      result.push(node);
      if (node.childCircles && node.childCircles.length > 0) {
        result = result.concat(flattenTree(node.childCircles));
      }
    });
    return result;
  }, []);

  const handleCollapse = useCallback((id: string) => {
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const flatData = flattenTree(treeData);
    
    // Create initial nodes with the right type based on expanded state
    const initialNodes: Node[] = flatData.map((item) => {
      const isExpanded = expandedCircleIds.has(item.id);
      return {
        id: item.id,
        type: isExpanded ? "expandedCircleNode" : "circleNode",
        position: { x: 0, y: 0 },
        data: {
          circleId: item.id,
          workspaceId: item.workspaceId,
          name: item.name,
          purposeMd: item.purposeMd,
          maturityStage: item.maturityStage,
          roleCount: item.roles?.length || 0,
          roles: item.roles || [],
          onCollapse: handleCollapse,
          onExpand: (id: string) => {
            setExpandedCircleIds(prev => {
              const next = new Set(prev);
              next.add(id);
              return next;
            });
          },
        },
      };
    });

    const initialEdges: Edge[] = flatData
      .filter((item) => item.parentCircleId)
      .map((item) => ({
        id: `e-${item.parentCircleId}-${item.id}`,
        source: item.parentCircleId,
        target: item.id,
        type: "smoothstep",
        animated: true,
        style: { stroke: 'var(--muted)', strokeWidth: 2 },
      }));

    if (initialNodes.length > 0) {
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
        initialNodes,
        initialEdges,
        'TB'
      );
      // Preserve selection state
      layoutedNodes.forEach(n => {
        if (n.id === selectedCircleId) n.selected = true;
      });
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
    } else {
      setNodes([]);
      setEdges([]);
    }
  }, [treeData, flattenTree, setNodes, setEdges, expandedCircleIds, handleCollapse, selectedCircleId]);

  const onNodeDoubleClick = useCallback((_: any, node: Node) => {
    setExpandedCircleIds(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }, []);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setNodes((nds: Node[]) => 
      nds.map((n: Node) => ({
        ...n,
        selected: n.id === node.id
      }))
    );
    setSelectedCircleId(node.data.circleId as string);
  }, [setNodes]);

  const handleClosePanel = () => {
    setSelectedCircleId(null);
    setNodes((nds: Node[]) => nds.map((n: Node) => ({ ...n, selected: false })));
  };


  return (
    <div style={{ width: "100%", height: "70vh", minHeight: 600, border: "1px solid var(--line)", borderRadius: "var(--radius-lg)", overflow: "hidden", position: "relative", background: "var(--bg)" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={2}
        attributionPosition="bottom-right"
      >
        <Controls />
        <Background gap={24} size={1} color="var(--line)" />
      </ReactFlow>
      
      <CircleDetailPanel 
        open={!!selectedCircleId} 
        circleId={selectedCircleId} 
        treeData={treeData} 
        onClose={handleClosePanel}
        isDemo={isDemo}
      />
    </div>
  );
}
